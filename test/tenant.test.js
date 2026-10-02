import test from 'node:test';
import assert from 'node:assert/strict';
import { TenantDatabase } from '../src/db/tenant.js';
const context={hubId:'00000000-0000-4000-8000-000000000001',orgIds:[],isStaff:false};
function mock() {
  const calls=[]; const client={query:async(...args)=>{calls.push(args);return {rows:[]};},release:broken=>calls.push(['release',broken])};
  return {calls,db:new TenantDatabase({connect:async()=>client})};
}
test('tenant context is local and parameterised in a repeatable-read transaction',async()=>{
  const {calls,db}=mock(); await db.withSnapshot(context,tx=>tx.query('SELECT 1'));
  assert.equal(calls[0][0],'BEGIN ISOLATION LEVEL REPEATABLE READ');
  assert.deepEqual(calls[1][1],[context.hubId,'[]','false']);
  assert.equal(calls.at(-2)[0],'COMMIT');
});
test('failed operation rolls back',async()=>{
  const {calls,db}=mock(); await assert.rejects(db.withSnapshot(context,()=>{throw Error('failure');}));
  assert.equal(calls.at(-2)[0],'ROLLBACK');
});
test('transaction query capability expires',async()=>{
  const {db}=mock(); let query; await db.withSnapshot(context,tx=>{query=tx.query;});
  assert.throws(()=>query('SELECT 1'),/ended/);
});
test('invalid tenant context never checks out connection',async()=>{
  const {calls,db}=mock(); await assert.rejects(db.withSnapshot({...context,hubId:'injected'},()=>{})); assert.equal(calls.length,0);
});
