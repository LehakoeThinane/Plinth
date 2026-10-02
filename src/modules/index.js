export const modules = Object.freeze({
  identity: ['Global users', 'Authentication links'],
  tenancy: ['Hubs', 'Membership', 'Organisation membership', 'Verified tenant contexts'],
  catalogue: ['Products', 'Lessons', 'Assets metadata', 'Pricing plans'],
  commerce: ['Orders', 'Subscriptions', 'Seat pools', 'Ledger', 'Settlements'],
  access: ['Entitlements', 'Access versions', 'Inherited access decisions'],
  content: ['Signed delivery', 'Video adapter', 'Document stamping', 'Progress'],
  library: ['Library publishing'],
  community: ['Spaces', 'Posts', 'Comments', 'Reactions', 'Reports'],
  messaging: ['Conversations', 'Participants', 'Messages', 'Delivery authorisation'],
  compliance: ['Consent', 'Retention', 'Deletion', 'Audit', 'Support access'],
  outbox: ['Transactional events', 'Retryable consumers']
});
// These are module boundaries, not completed modules. Cross-module operations
// must use explicit interfaces and the same transaction for commerce/access.
