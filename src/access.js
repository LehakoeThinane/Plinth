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
