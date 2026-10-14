import { TenantDatabase } from '../db/tenant.js';
import { HubRepository } from '../db/hub-repository.js';
import { OrganisationRepository } from '../db/organisation-repository.js';
import { CatalogueRepository } from '../db/catalogue-repository.js';
import { LibraryRepository } from '../db/library-repository.js';
import { TierRepository } from '../db/tier-repository.js';
import { CommunityRepository } from '../db/community-repository.js';
import { CommunityService } from '../modules/community/community-service.js';
import { MessagingRepository } from '../db/messaging-repository.js';
import { NoticeRepository } from '../db/notice-repository.js';
import { PostgresAccessRepository } from '../db/access-repository.js';
import { AccessService } from '../access.js';
import { MemoryAccessCache } from '../cache/memory.js';
import { randomUUID } from 'node:crypto';
import { SeatRepository } from '../db/seat-repository.js';
export const demoSlug='zoya-speaks';
/** Demo personas offered on the test sign-in page. */
export const demoPeople=[
  {subject:'zoya',name:'Zoya (provider)',role:'Owns the Zoya Speaks hub: products, library, tiers, moderation, sales, company seats'},
  {subject:'thabo',name:'Thabo (learner)',role:'A hub member who has started the free course'},
  {subject:'lerato',name:'Lerato (Absa admin)',role:'Administers Absa (demo): assigns company seats; sees the private programme and space'},
  {subject:'sipho',name:'Sipho (prospect)',role:'Not a member yet; has sent an enquiry'}
];
const text=(...paragraphs)=>paragraphs.join('\n\n');
/** Creates the demo hub once, mostly through the application's own repositories
 * so the data obeys the same rules as real use. Local development only.
 */
export async function seedDemo({admin,app,issuer,environment=process.env.NODE_ENV}) {
  if(environment==='production')throw new Error('Demo data is for local development only');
  const existing=(await admin.query('SELECT id FROM tenancy.hubs WHERE slug=$1',[demoSlug])).rows[0];
  await admin.query('INSERT INTO identity.auth_issuers(issuer,enabled) VALUES($1,true) ON CONFLICT(issuer) DO UPDATE SET enabled=true',[issuer]);
  const ids={};
  for(const person of demoPeople) {
    const linked=(await admin.query('SELECT user_id FROM identity.auth_links WHERE issuer=$1 AND subject=$2',[issuer,person.subject])).rows[0];
    ids[person.subject]=linked?.user_id??randomUUID();
    if(!linked) {
      await admin.query('INSERT INTO identity.users(id,display_name) VALUES($1,$2)',[ids[person.subject],person.name.split(' ')[0]]);
      await admin.query('INSERT INTO identity.auth_links(issuer,subject,user_id) VALUES($1,$2,$3)',[issuer,person.subject,ids[person.subject]]);
    }
  }
  if(existing){await ensureSeats({admin,db:new TenantDatabase(app),ids,hubId:existing.id});return {created:false,hubId:existing.id};}
  const db=new TenantDatabase(app);
  const hub=await new HubRepository(db,ids.zoya).create({slug:demoSlug,displayName:'Zoya Speaks'});
  const hubId=hub.id;
  await new HubRepository(db,ids.zoya).brand(hubId,{description:'Public speaking programmes for leaders and teams: BE HEARD, digital presentation skills and keynote coaching.',primaryColor:'#7A2E8C',font:'serif'});
  await admin.query("INSERT INTO tenancy.memberships(hub_id,user_id,role,status) VALUES($1,$2,'member','active'),($1,$3,'member','active')",[hubId,ids.thabo,ids.lerato]);
  const absa=await new OrganisationRepository(db,ids.lerato).create(hubId,{displayName:'Absa (demo)',legalName:'Absa Demo Ltd',type:'company'});
  const catalogue=new CatalogueRepository(db,ids.zoya);
  async function product(input,modules,plans=[]) {
    const created=await catalogue.create(hubId,input);
    for(const [title,lessons] of modules) {
      const module=await catalogue.addModule(hubId,created.id,{title});
      for(const [lessonTitle,body,preview=false] of lessons) {
        const lesson=await catalogue.addLesson(hubId,created.id,{moduleId:module.id,title:lessonTitle,previewAvailable:preview});
        await catalogue.setLessonContent(hubId,created.id,lesson.id,{body});
        (created.lessons??=[]).push(lesson.id);
      }
    }
    for(const plan of plans)await catalogue.addPlan(hubId,created.id,plan);
    await catalogue.publish(hubId,created.id);
    return created;
  }
  const beHeard=await product({type:'course',title:'BE HEARD: Speak with presence',summary:'A six-week course in voice, structure and calm under pressure.',visibility:'public',accessMode:'entitled'},[
    ['Foundations',[['Why your voice matters',text('Every talk is a promise to your audience.','In this course you will learn to keep it: with a clear message, a steady voice and a plan for nerves.'),true],
      ['Breath and pace',text('Breathe low and slow before you start.','Pause after every key point. Silence feels long to you and natural to your audience.')]]],
    ['Practice',[['Structuring a five-minute talk',text('Open with a question, make three points, close with one action.','Rehearse out loud, standing up, at least three times.')],
      ['Handling nerves',text('Nerves are energy. Name the feeling, slow your breath and look for a friendly face.')]]]
  ],[{model:'once_off',amountCents:120000},{model:'subscription',amountCents:14900,interval:'month'}]);
  const quickWins=await product({type:'toolkit',title:'Speaking quick wins',summary:'Free tips you can use in your next meeting.',visibility:'public',accessMode:'open'},[
    ['Quick wins',[['The one-sentence message',text('Before any talk, write your message in one sentence. If you cannot, you are not ready.')],
      ['Ending with an ask',text('Finish with one clear request so people know what to do next.')]]]
  ]);
  await product({type:'programme',title:'Absa leadership voice programme',summary:'Private programme for Absa leaders.',visibility:'company',accessMode:'entitled',companyOrg:absa.id},[
    ['Leading the room',[['Presence for leaders',text('This private programme is visible only to Absa employees.')]]]
  ]);
  const library=new LibraryRepository(db,ids.zoya);
  const tiers=new TierRepository(db,ids.zoya),tier=await tiers.create(hubId,{name:'Inner Circle',description:'Monthly masterclass notes, the members lounge and BE HEARD included.',rank:1,amountCents:19900,interval:'month'});
  for(const [title,visibility,body,topics] of [
    ['Five ways to calm pre-talk nerves','public',text('Arrive early. Walk the room. Breathe out longer than you breathe in.','Have a glass of water ready, and know your first sentence by heart.'),['nerves','preparation']],
    ['The pause: your secret weapon','members',text('A two-second pause before your key point makes people lean in.'),['delivery']],
    ['Inner Circle masterclass notes: October','tier',text('This month: handling hostile questions with curiosity instead of defence.'),['masterclass']]]) {
    const item=await library.create(hubId,{title,summary:title,body,visibility,topics});
    await library.setStatus(hubId,item.id,'published');
    if(visibility==='tier')await tiers.addBenefit(hubId,tier.id,{targetType:'library',targetId:item.id});
  }
  const community=new CommunityRepository(db,ids.zoya);
  const lounge=await community.createSpace(hubId,{title:'Speakers lounge',description:'Share wins, questions and practice clips.',visibility:'hub'});
  const inner=await community.createSpace(hubId,{title:'Inner Circle lounge',description:'For Inner Circle members.',visibility:'tier'});
  await community.createSpace(hubId,{title:'Absa cohort',description:'Private space for the Absa programme.',visibility:'company',companyOrg:absa.id});
  await tiers.addBenefit(hubId,tier.id,{targetType:'product',targetId:beHeard.id});
  await tiers.addBenefit(hubId,tier.id,{targetType:'space',targetId:inner.id});
  await tiers.setStatus(hubId,tier.id,'published');
  const cache=new MemoryAccessCache(),access=user=>new AccessService(new PostgresAccessRepository(db,user),cache);
  await new CommunityService({access:access(ids.zoya),userId:ids.zoya}).createPost(hubId,lounge.id,{body:'Welcome to the lounge! Introduce yourself and tell us one talk you have coming up.'});
  await new CommunityService({access:access(ids.thabo),userId:ids.thabo}).createPost(hubId,lounge.id,{body:'Hi all, Thabo here. I present to our board next month and I am nervous!'});
  await new NoticeRepository(db,ids.zoya).publish(hubId,{purpose:'marketing',noticeVersion:'2026-10',noticeText:'Send me occasional emails about new programmes and events from Zoya Speaks.',expectedVersion:null});
  await new MessagingRepository(db,ids.sipho).createEnquiry(hubId,{subject:'Keynote for our sales conference',need:'We are looking for a 45-minute keynote on confident presenting for 200 people in March.'});
  await access(ids.thabo).recordProgress({hubId,userId:ids.thabo,lessonId:quickWins.lessons[0],idempotencyKey:'demo-seed-progress-1',
    update:{baseRevision:0,furthestPosition:1,resumePosition:1,completed:true}});
  await ensureSeats({admin,db,ids,hubId});
  return {created:true,hubId};
}
/** Company seats demo, added to existing demo hubs too: a per-seat price on BE
 * HEARD, and Zoya's grant of Absa programme seats, one of them held by Lerato.
 */
async function ensureSeats({admin,db,ids,hubId}) {
  const find=async(sql,params)=>(await admin.query(sql,params)).rows[0]?.id;
  const beHeard=await find("SELECT id FROM catalogue.products WHERE hub_id=$1 AND title LIKE 'BE HEARD%'",[hubId]);
  const programme=await find("SELECT id FROM catalogue.products WHERE hub_id=$1 AND title='Absa leadership voice programme'",[hubId]);
  const absa=await find("SELECT o.id FROM identity.organisations o JOIN identity.org_members m ON m.org_id=o.id WHERE m.user_id=$1 AND o.display_name='Absa (demo)'",[ids.lerato]);
  if(!beHeard||!programme||!absa)return;
  if(!await find("SELECT id FROM catalogue.plans WHERE hub_id=$1 AND product_id=$2 AND model='per_seat' AND status='active'",[hubId,beHeard]))
    await new CatalogueRepository(db,ids.zoya).addPlan(hubId,beHeard,{model:'per_seat',amountCents:95000});
  const {poolId}=await new SeatRepository(db,ids.zoya).grant(hubId,{orgId:absa,productId:programme,seats:10,reference:'ABSA-PO-2026-118',idempotencyKey:'demo-absa-seat-grant'});
  await new SeatRepository(db,ids.lerato).assign(hubId,poolId,ids.lerato);
}
