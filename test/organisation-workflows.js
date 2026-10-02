import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { TenantDatabase } from '../src/db/tenant.js';
import { OrganisationRepository } from '../src/db/organisation-repository.js';
import { auditPolicies } from '../src/db/policy-audit.js';
export async function organisationChecks({admin,app,db,a,b,userA,userB,check,testOrgs,testUsers,embeddedMode}) {
  const owner=new OrganisationRepository(db,userA),other=new OrganisationRepository(db,userB);let orgId;
  await check('organisation creation atomically adds the creator as admin without hub membership',async()=>{
    const org=await owner.create(a,{displayName:'Company <script>bad</script>',legalName:'Company Ltd',type:'company',role:'member'});
    orgId=org.id;testOrgs.push(orgId);
    const view=await owner.admin(b,orgId);assert.equal(view.organisation.type,'company');
    assert.deepEqual(view.members,[{userId:userA,role:'admin',status:'active'}]);assert.equal(view.events[0].action,'created');
    assert.equal((await admin.query('SELECT * FROM tenancy.memberships WHERE hub_id=$1 AND user_id=$2',[b,userA])).rows.length,0);
    await assert.rejects(owner.create(a,{displayName:'',legalName:'Company',type:'company'}),{status:400});
  });
  await check('organisation executor is constrained and runtime cannot bypass membership writes or audit',async()=>{
    const role=(await admin.query("SELECT rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname='plinth_identity_executor'")).rows[0];
    assert.deepEqual(role,{rolcanlogin:false,rolsuper:false,rolbypassrls:false});
    for(const runtime of ['plinth_app','plinth_auth'])assert.equal((await admin.query("SELECT pg_has_role($1,'plinth_identity_executor','MEMBER') AS member",[runtime])).rows[0].member,false);
    for(const signature of ['app.create_organisation(uuid,text,text,text,uuid)','app.organisation_admin_view(uuid)','app.manage_organisation(uuid,text,jsonb,uuid)'])
      assert.equal((await admin.query('SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid=$1::regprocedure',[signature])).rows[0].owner,'plinth_identity_executor');
    if(!embeddedMode)await assert.rejects(app.query('SET ROLE plinth_identity_executor'),{code:'42501'});
    for(const table of ['identity.org_invitations','identity.org_events'])await assert.rejects(app.query('SELECT * FROM '+table),{code:'42501'});
    await assert.rejects(db.withSnapshot({hubId:a,userId:userA,orgIds:[],isStaff:false},tx=>tx.query("UPDATE identity.org_members SET role='admin'")),{code:'42501'});
    await assert.rejects(app.query('DELETE FROM identity.org_events'),{code:'42501'});
  });
  await check('policy harness detects a missing organisation invitation boundary',async()=>{
    const c=await admin.connect();try{await c.query('BEGIN');await c.query('DROP POLICY executor_scope ON identity.org_invitations');await assert.rejects(auditPolicies(c),/Unsafe identity policies/);}
    finally{await c.query('ROLLBACK');c.release();}
  });
  await check('non-admins cannot inspect, rename or invite into another organisation',async()=>{
    await assert.rejects(other.admin(a,orgId),{status:404});
    await assert.rejects(other.rename(a,orgId,{displayName:'Forged',legalName:'Forged'}),{status:404});
    await assert.rejects(other.invite(a,orgId,{userId:userB}),{status:404});
  });
  await check('invitation requires the intended account, stores only a hash and acceptance is one-use',async()=>{
    const invitation=await owner.invite(a,orgId,{userId:userB,role:'admin'});
    const row=(await admin.query('SELECT token_hash FROM identity.org_invitations WHERE id=$1',[invitation.id])).rows[0];assert.notEqual(row.token_hash,invitation.token);
    const view=await owner.admin(a,orgId);assert.ok(!JSON.stringify(view).includes(invitation.token));assert.ok(!JSON.stringify(view).includes(row.token_hash));
    await assert.rejects(owner.accept(a,orgId,invitation),{status:404});await other.accept(b,orgId,invitation);
    assert.equal((await owner.admin(a,orgId)).members.find(m=>m.userId===userB).role,'member');
    await assert.rejects(other.accept(a,orgId,invitation),{status:404});await assert.rejects(other.admin(a,orgId),{status:404});
  });
  await check('role changes preserve the last active admin and revoke authority immediately',async()=>{
    await assert.rejects(owner.member(a,orgId,userA),{status:409});await assert.rejects(owner.member(a,orgId,userA,'member'),{status:409});
    await owner.member(a,orgId,userB,'admin');await other.member(a,orgId,userA,'member');
    await assert.rejects(owner.rename(a,orgId,{displayName:'Denied',legalName:'Denied'}),{status:404});await other.member(a,orgId,userA,'admin');
  });
  await check('concurrent admin removals cannot leave an organisation without an administrator',async()=>{
    const pool=embeddedMode?null:new pg.Pool({connectionString:process.env.DATABASE_URL,max:2});
    const concurrent=pool?new OrganisationRepository(new TenantDatabase(pool),userB):other;
    try {
      const result=await Promise.allSettled([owner.member(a,orgId,userB),concurrent.member(a,orgId,userA)]);assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
      const active=(await admin.query("SELECT user_id FROM identity.org_members WHERE org_id=$1 AND status='active' AND role='admin'",[orgId])).rows;assert.equal(active.length,1);
      const survivor=active[0].user_id===userA?owner:other,removed=active[0].user_id===userA?other:owner,target=active[0].user_id===userA?userB:userA;
      const invite=await survivor.invite(a,orgId,{userId:target});await removed.accept(a,orgId,invite);await survivor.member(a,orgId,target,'admin');
    }finally{if(pool)await pool.end();}
  });
  await check('expired revoked and demoted-inviter invitations cannot restore membership',async()=>{
    await owner.member(a,orgId,userB);
    const expired=await owner.invite(a,orgId,{userId:userB});await admin.query("UPDATE identity.org_invitations SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.id]);await assert.rejects(other.accept(a,orgId,expired),{status:404});
    const revoked=await owner.invite(a,orgId,{userId:userB});await owner.revoke(a,orgId,revoked.id);await assert.rejects(other.accept(a,orgId,revoked),{status:404});
    const invite=await owner.invite(a,orgId,{userId:userB});await other.accept(a,orgId,invite);await owner.member(a,orgId,userB,'admin');
    const third=randomUUID();testUsers.push(third);await admin.query('INSERT INTO identity.users(id) VALUES($1)',[third]);
    const pending=await owner.invite(a,orgId,{userId:third});await other.member(a,orgId,userA,'member');
    await assert.rejects(new OrganisationRepository(db,third).accept(a,orgId,pending),{status:404});await other.member(a,orgId,userA,'admin');
  });
  await check('removing membership increments the authoritative user access version',async()=>{
    const before=(await admin.query('SELECT access_version FROM identity.users WHERE id=$1',[userB])).rows[0].access_version;
    await owner.member(a,orgId,userB);
    const after=(await admin.query('SELECT access_version FROM identity.users WHERE id=$1',[userB])).rows[0].access_version;assert.ok(BigInt(after)>BigInt(before));
  });
  return {orgId,owner,other};
}
