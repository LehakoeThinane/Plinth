/** Local/test cache. Redis adapter remains a separate integration. */
export class MemoryAccessCache {
  #values=new Map();
  async get(key){const item=this.#values.get(key);if(!item)return null;if(item.until<=Date.now()){this.#values.delete(key);return null;}return structuredClone(item.value);}
  async set(key,value,ttl){this.#values.set(key,{value:structuredClone(value),until:Date.now()+ttl*1000});}
}
