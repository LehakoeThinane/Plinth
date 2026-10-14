import { CommunityRepository as Repository,communityError } from '../../db/community-repository.js';
const fail=status=>Object.assign(new Error('Community request rejected'),{status});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Community for one verified person. Every read and write runs after the
 * space access decision, in the same transaction (AccessService.inSpace).
 * Locked tier spaces show their description but no posts; writes need full access.
 */
export class CommunityService {
  #access;#userId;
  constructor({access,userId}) {this.#access=access;this.#userId=userId;}
  #signedIn(){if(!this.#userId)throw fail(401);}
  async #within(target,operation,{write=false}={}) {
    this.#signedIn();
    for(const value of Object.values(target).slice(1))if(value!==undefined&&!uuid.test(value??''))throw fail(400);
    try {
      return await this.#access.inSpace({...target,userId:this.#userId},async ({decision,query,spaceId})=>{
        if(decision.decision==='not_found')throw fail(404);
        if(decision.decision==='locked'){if(write)throw fail(403);return {decision:'locked',reason:decision.reason==='purchase'?'tier':decision.reason};}
        return operation(query,spaceId);
      });
    }catch(error){throw communityError(error);}
  }
  async spaces(hubId) {this.#signedIn();return {spaces:await this.#access.spaces({hubId,userId:this.#userId})};}
  async feed(hubId,spaceId,options) {return this.#within({hubId,spaceId},query=>Repository.feed(query,spaceId,this.#userId,options));}
  async post(hubId,postId) {return this.#within({hubId,postId},query=>Repository.post(query,postId,this.#userId));}
  async createPost(hubId,spaceId,input) {
    return this.#within({hubId,spaceId},query=>Repository.createPost(query,{hubId,spaceId,userId:this.#userId,text:input.body}),{write:true});
  }
  async comment(hubId,postId,input) {
    return this.#within({hubId,postId},query=>Repository.createComment(query,{hubId,postId,userId:this.#userId,text:input.body}),{write:true});
  }
  async react(hubId,postId,kind,on) {return this.#within({hubId,postId},query=>Repository.react(query,{hubId,postId,userId:this.#userId,kind,on}),{write:true});}
  async withdraw(hubId,type,targetId) {
    const target=type==='post'?{hubId,postId:targetId}:{hubId,commentId:targetId};
    return this.#within(target,query=>Repository.withdraw(query,{type,targetId,userId:this.#userId}),{write:true});
  }
  async report(hubId,input) {
    if(!['post','comment'].includes(input?.targetType))throw fail(400);
    const target=input.targetType==='post'?{hubId,postId:input.targetId}:{hubId,commentId:input.targetId};
    return this.#within(target,(query,spaceId)=>Repository.report(query,{hubId,spaceId,type:input.targetType,targetId:input.targetId,userId:this.#userId,reason:input.reason}),{write:true});
  }
}
