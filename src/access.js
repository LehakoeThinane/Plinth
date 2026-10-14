import { createHash } from 'node:crypto';
import { mergeProgress } from './progress.js';
const maxPosition = 10000000;
const rejected = status => Object.assign(new Error('Progress rejected'), { status });
/**
 * The repository must run withSnapshot in a tenant-scoped, consistent DB snapshot.
 * getTargetChain returns [target, ...ancestors], including every access parent.
 * getAccessSummary reads membership, organisations, entitlements and tier benefits.
 * getVersions always reads authoritative storage, never an outbox-fed Redis key.
 */
export class AccessService {
  constructor(repository, cache, now = () => Date.now()) {
    this.repository = repository;
    this.cache = cache;
    this.now = now;
  }

  async check({ hubId, userId = null, targetId, operation = 'content' }) {
    if (!['content', 'listing'].includes(operation)) throw new Error('Unknown operation');
    return this.repository.withSnapshot(hubId, async (snapshot) => {
      const chain = await snapshot.getTargetChain(targetId);
      if (!chain?.length || chain.some(row => row.hubId !== hubId)) return notFound();
      let summary = null;
      if (userId) summary = await this.freshSummary(snapshot, hubId, userId);
      return this.evaluate(chain, summary, operation);
    });
  }

  /** Opens a lesson: decides on fresh data, then reads its content in the SAME
   * snapshot, so content is never served on a decision from different data.
   * Locked results carry only the preview fields, never the body.
   */
  async open({ hubId, userId = null, lessonId, device = null }) {
    return this.repository.withSnapshot(hubId, async (snapshot) => {
      const chain = await snapshot.getTargetChain(lessonId);
      if (!chain?.length || chain.some(row => row.hubId !== hubId)) return notFound();
      const summary = userId ? await this.freshSummary(snapshot, hubId, userId) : null;
      const decision = this.evaluate(chain, summary, 'content');
      if (decision.decision === 'not_found') return decision;
      const lesson = await snapshot.getLessonContent(lessonId);
      if (!lesson) return notFound();
      if (decision.decision === 'locked') {
        const { body, ...preview } = lesson;
        return { ...decision, lesson: preview };
      }
      const progress = userId ? await snapshot.getProgress(lessonId) : null;
      // Record who received the content, in the same transaction as the decision.
      if (userId) await snapshot.logOpen(lessonId, typeof device === 'string' ? device.slice(0, 300) : null);
      return { decision: 'allowed', lesson: { ...lesson, progress } };
    });
  }

  /** Opens a library item through the same decision path as lessons. Items are
   * always previewable: a locked result names how to unlock it, never the body.
   */
  async openLibraryItem({ hubId, userId = null, itemId }) {
    return this.repository.withSnapshot(hubId, async (snapshot) => {
      const chain = await snapshot.getLibraryChain(itemId);
      if (!chain?.length || chain.some(row => row.hubId !== hubId)) return notFound();
      const summary = userId ? await this.freshSummary(snapshot, hubId, userId) : null;
      const decision = this.evaluate(chain, summary, 'content');
      if (decision.decision === 'not_found') return decision;
      const item = await snapshot.getLibraryItem(itemId);
      if (!item) return notFound();
      if (decision.decision === 'locked') {
        const { body, ...preview } = item;
        // A tier item is unlocked by a tier, not a purchase.
        const reason = decision.reason === 'purchase' && item.visibility === 'tier' ? 'tier' : decision.reason;
        return { decision: 'locked', reason, item: preview };
      }
      return { decision: 'allowed', item };
    });
  }

  /** Saves progress only for a lesson the learner can open now, decided in the
   * same transaction. A retried request with the same idempotency key returns
   * the stored result; the same key with a different payload is a conflict.
   */
  async recordProgress({ hubId, userId, lessonId, update, idempotencyKey }) {
    if (!userId) throw rejected(401);
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) throw rejected(400);
    const fields = { baseRevision: update?.baseRevision, furthestPosition: update?.furthestPosition,
      resumePosition: update?.resumePosition, completed: update?.completed };
    if ([fields.furthestPosition, fields.resumePosition].some(p => typeof p !== 'number' || p > maxPosition)) throw rejected(400);
    const requestHash = createHash('sha256').update(JSON.stringify({ lessonId, ...fields })).digest('hex');
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.repository.withSnapshot(hubId, async (snapshot) => {
          const replay = await snapshot.findProgressRequest(idempotencyKey);
          if (replay) {
            if (replay.requestHash !== requestHash) throw rejected(409);
            return replay.response;
          }
          const chain = await snapshot.getTargetChain(lessonId);
          if (!chain?.length || chain.some(row => row.hubId !== hubId)) throw rejected(404);
          const summary = await this.freshSummary(snapshot, hubId, userId);
          if (this.evaluate(chain, summary, 'content').decision !== 'allowed') throw rejected(404);
          const current = await snapshot.lockProgress(lessonId) ??
            { revision: 0, furthestPosition: 0, resumePosition: 0, completed: false };
          let merged;
          try { merged = mergeProgress(current, fields); } catch { throw rejected(400); }
          await snapshot.writeProgress(lessonId, merged.state, current.revision === 0);
          // A stale resume change is reported, never silently treated as applied.
          const response = { progress: merged.state, resumeConflict: merged.resumeConflict };
          await snapshot.storeProgressRequest(idempotencyKey, requestHash, response);
          return response;
        });
      } catch (error) {
        // Concurrent saves of one lesson or key: retry; the replay check then answers.
        if (['40001', '40P01', '23505'].includes(error.code) && attempt < 2) continue;
        if (['40001', '40P01', '23505'].includes(error.code)) throw rejected(409);
        throw error;
      }
    }
  }

  async freshSummary(snapshot, hubId, userId) {
    const versions = await snapshot.getVersions(userId);
    if (!versions) return null;
    const key = 'hub:' + hubId + ':access:' + userId;
    const cached = await this.cache.get(key).catch(() => null);
    if (cached && cached.userVersion === versions.userVersion &&
        cached.hubEpoch === versions.hubEpoch) return cached.summary;
    const summary = await snapshot.getAccessSummary(userId);
    await this.cache.set(key, { ...versions, summary }, 300).catch(() => {});
    return summary;
  }

  evaluate(chain, summary, operation) {
    const now = this.now();
    const activeMember = summary?.membership?.status === 'active';
    const staff = activeMember && ['owner', 'admin', 'facilitator', 'staff']
      .includes(summary.membership.role);
    // Resolve all inherited company boundaries before previews or public shortcuts.
    for (const row of chain) {
      if (row.companyOrg && !staff &&
          (!activeMember || !summary.orgIds.includes(row.companyOrg))) return notFound();
    }
    if (summary?.membership?.status === 'suspended') return notFound();
    const published = chain.every(row => row.status === 'published');
    if (!published && !staff) return notFound();
    if (staff) return { decision: 'allowed' };
    // A public product listing is metadata only; it never grants lesson access.
    if (operation === 'listing') {
      return published && chain[0].visibility === 'public' &&
        chain.every(row => !row.companyOrg)
        ? { decision: 'allowed', metadataOnly: true } : notFound();
    }
    // Every ancestor contributes a requirement; child flags cannot relax it.
    for (const row of chain) {
      if (row.access === 'open') continue;
      if (!activeMember) return this.lockedOrHidden(chain, 'join');
      if (row.access === 'members') continue;
      if (row.access === 'entitled') {
        const direct = summary.entitlements.some(e => e.targetId === row.id &&
          !e.revoked && (e.expiresAt == null || e.expiresAt > now));
        const tier = summary.entitlements.some(e => e.kind === 'tier' &&
          !e.revoked && (e.expiresAt == null || e.expiresAt > now) &&
          (summary.tierBenefits[e.targetId] ?? []).includes(row.id));
        if (direct || tier) continue;
        return this.lockedOrHidden(chain, 'purchase');
      }
      return notFound(); // Unknown access mode fails closed.
    }
    return { decision: 'allowed' };
  }

  lockedOrHidden(chain, reason) {
    if (chain.some(row => row.companyOrg) || !chain[0].previewAvailable) return notFound();
    return { decision: 'locked', reason };
  }

  /** Authorise each recipient at delivery, including user-level revocations. */
  async recipients({ hubId, conversationId, candidateUserIds }) {
    return this.repository.withSnapshot(hubId, async (snapshot) => {
      const conversation = await snapshot.getConversation(conversationId);
      if (!conversation || conversation.hubId !== hubId) return [];
      const allowed = [];
      for (const userId of new Set(candidateUserIds)) {
        const summary = await this.freshSummary(snapshot, hubId, userId);
        if (summary?.membership?.status !== 'active') continue;
        if (!conversation.participantIds.includes(userId)) continue;
        if (conversation.companyOrg && !summary.orgIds.includes(conversation.companyOrg) &&
            !['owner', 'admin', 'facilitator', 'staff'].includes(summary.membership.role)) continue;
        allowed.push(userId);
      }
      return allowed;
    });
  }
}
const notFound = () => ({ decision: 'not_found' });
