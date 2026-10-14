/** Uses the separate plinth_maintenance login, which can only call the
 * retention functions. Never give this pool to request-handling code.
 */
export class MaintenanceRepository {
  #pool;
  constructor(pool) {if(!pool)throw Error('Maintenance pool required');this.#pool=pool;}
  async #call(fn,amount,apply) {
    try{return Number((await this.#pool.query('SELECT app.'+fn+'($1,$2) AS affected',[amount,apply])).rows[0].affected);}
    catch(error){if(error.code==='22023')throw Object.assign(new Error('Invalid retention period'),{status:400});throw error;}
  }
  expireLessonOpens(days,apply=false) {return this.#call('expire_lesson_opens',days,apply);}
  expireProgressRequests(hours,apply=false) {return this.#call('expire_progress_requests',hours,apply);}
}
