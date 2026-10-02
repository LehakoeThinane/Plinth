terraform {
  required_version = ">= 1.10, < 2.0"
  backend "s3" {}
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.7" }
  }
}
provider "aws" {
  region              = "af-south-1"
  profile             = var.aws_profile
  allowed_account_ids = [var.account_id]
  default_tags { tags = { Project = "EKX", Environment = "staging", ManagedBy = "Terraform" } }
}
variable "aws_profile" { default = "ekx-staging" }
variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "Supply the verified staging account ID."
  }
}
variable "asset_bucket_name" { type = string }
variable "availability_zones" {
  type = list(string)
  validation {
    condition     = length(var.availability_zones) == 2 && length(distinct(var.availability_zones)) == 2 && alltrue([for az in var.availability_zones : startswith(az, "af-south-1")])
    error_message = "Specify two distinct, account-available Cape Town availability zones."
  }
}
variable "postgres_version" { type = string }
variable "redis_version" { type = string }
resource "aws_vpc" "staging" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
}
resource "aws_subnet" "private" {
  count                   = 2
  vpc_id                  = aws_vpc.staging.id
  cidr_block              = cidrsubnet(aws_vpc.staging.cidr_block, 8, count.index)
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = false
}
# Isolated subnets: no internet gateway, public routes or NAT is created.
resource "aws_security_group" "application" {
  name_prefix = "ekx-staging-app-"
  vpc_id      = aws_vpc.staging.id
}
resource "aws_security_group" "database" {
  name_prefix = "ekx-staging-db-"
  vpc_id      = aws_vpc.staging.id
}
resource "aws_security_group" "cache" {
  name_prefix = "ekx-staging-cache-"
  vpc_id      = aws_vpc.staging.id
}
resource "aws_vpc_security_group_ingress_rule" "database" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.application.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
resource "aws_vpc_security_group_egress_rule" "database" {
  security_group_id            = aws_security_group.application.id
  referenced_security_group_id = aws_security_group.database.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
resource "aws_vpc_security_group_ingress_rule" "cache" {
  security_group_id            = aws_security_group.cache.id
  referenced_security_group_id = aws_security_group.application.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}
resource "aws_vpc_security_group_egress_rule" "cache" {
  security_group_id            = aws_security_group.application.id
  referenced_security_group_id = aws_security_group.cache.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}
resource "aws_db_subnet_group" "staging" {
  name       = "ekx-staging"
  subnet_ids = aws_subnet.private[*].id
}
resource "aws_db_parameter_group" "staging" {
  name_prefix = "ekx-staging-"
  family      = "postgres17"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}
resource "aws_db_instance" "staging" {
  identifier                      = "ekx-staging"
  engine                          = "postgres"
  engine_version                  = var.postgres_version
  instance_class                  = "db.t4g.micro"
  allocated_storage               = 20
  max_allocated_storage           = 100
  storage_type                    = "gp3"
  storage_encrypted               = true
  db_name                         = "plinth"
  username                        = "plinth_migration_admin"
  manage_master_user_password     = true
  publicly_accessible             = false
  multi_az                        = false
  db_subnet_group_name            = aws_db_subnet_group.staging.name
  vpc_security_group_ids          = [aws_security_group.database.id]
  parameter_group_name            = aws_db_parameter_group.staging.name
  backup_retention_period         = 7
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  deletion_protection             = true
  skip_final_snapshot             = false
  final_snapshot_identifier       = "ekx-staging-final"
  auto_minor_version_upgrade      = true
  lifecycle { prevent_destroy = true }
}
resource "aws_elasticache_subnet_group" "staging" {
  name       = "ekx-staging"
  subnet_ids = aws_subnet.private[*].id
}
resource "random_password" "redis" {
  length  = 32
  special = false
}
resource "aws_elasticache_replication_group" "staging" {
  replication_group_id       = "ekx-staging"
  description                = "EKX isolated staging Redis"
  engine                     = "redis"
  engine_version             = var.redis_version
  node_type                  = "cache.t4g.micro"
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true
  subnet_group_name          = aws_elasticache_subnet_group.staging.name
  security_group_ids         = [aws_security_group.cache.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.redis.result
  snapshot_retention_limit   = 1
}
resource "aws_secretsmanager_secret" "redis" {
  name                    = "ekx/staging/redis"
  recovery_window_in_days = 30
}
resource "aws_secretsmanager_secret_version" "redis" {
  secret_id     = aws_secretsmanager_secret.redis.id
  secret_string = random_password.redis.result
}
resource "aws_secretsmanager_secret" "application_db" {
  name                    = "ekx/staging/application-database"
  recovery_window_in_days = 30
}
# The restricted application credential is provisioned after migrations.
# Runtime must never use the RDS master secret.
resource "aws_s3_bucket" "assets" {
  bucket = var.asset_bucket_name
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
resource "aws_s3_bucket_policy" "tls" {
  bucket = aws_s3_bucket.assets.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Sid       = "DenyInsecureTransport", Effect = "Deny", Principal = "*", Action = "s3:*",
    Resource  = [aws_s3_bucket.assets.arn, "${aws_s3_bucket.assets.arn}/*"],
    Condition = { Bool = { "aws:SecureTransport" = "false" } }
  }] })
}
output "database_endpoint" { value = aws_db_instance.staging.address }
output "database_master_secret_arn" { value = aws_db_instance.staging.master_user_secret[0].secret_arn }
output "application_database_secret_arn" { value = aws_secretsmanager_secret.application_db.arn }
output "redis_endpoint" { value = aws_elasticache_replication_group.staging.primary_endpoint_address }
output "redis_secret_arn" { value = aws_secretsmanager_secret.redis.arn }
output "asset_bucket" { value = aws_s3_bucket.assets.id }
output "application_security_group_id" { value = aws_security_group.application.id }
output "private_subnet_ids" { value = aws_subnet.private[*].id }

resource "aws_iam_role" "application" {
  name = "ekx-staging-application"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole"
  }] })
}
resource "aws_iam_role_policy" "application" {
  role = aws_iam_role.application.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = "${aws_s3_bucket.assets.arn}/hubs/*" },
    { Effect = "Deny", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.assets.arn },
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [aws_secretsmanager_secret.application_db.arn, aws_secretsmanager_secret.redis.arn] }
  ] })
}
output "application_role_arn" { value = aws_iam_role.application.arn }
