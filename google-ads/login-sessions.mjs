// Private, strongly consistent browser-login state. No Google tokens are stored.
// One object per opaque flow; it is reachable only through the Worker binding.
export class GoogleAdsLoginSessions {
  constructor(state) { this.state = state; }
  async fetch(request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/session') return new Response('Not found', { status: 404 });
    const job = await request.json();
    return Response.json(await this.state.storage.transaction(async tx => {
      const saved = await tx.get('session');
      if (job.operation === 'create') {
        const v = job.value;
        if (saved) return { error: 'LOGIN_SESSION_CONFLICT' };
        if (!v || !['google','consent'].includes(v.phase) || !/^[A-Za-z0-9_-]{43}$/.test(v.cookieHash) ||
            !Number.isFinite(v.expires) || v.expires <= Date.now() || v.expires > Date.now() + 600000) return { error: 'LOGIN_SESSION_INVALID' };
        await tx.put('session', v);
        await tx.setAlarm(v.expires);
        return { created: true };
      }
      if (!['read','consume'].includes(job.operation)) return { error: 'LOGIN_SESSION_INVALID' };
      if (!saved) return { error: 'LOGIN_SESSION_NOT_FOUND' };
      if (saved.expires <= Date.now()) {
        const expiredFor = Math.max(0, Math.floor((Date.now() - saved.expires) / 1000));
        await tx.delete('session');
        return { error: 'LOGIN_SESSION_EXPIRED', expired_for_seconds: Math.min(86400, expiredFor) };
      }
      if (saved.cookieHash !== job.cookieHash) return { error: 'LOGIN_SESSION_INVALID' };
      if (saved.phase !== job.phase) return { error: 'LOGIN_SESSION_PHASE_MISMATCH' };
      // The read/check/delete is one transaction, before the caller exchanges a
      // Google code or creates a downstream grant. A replay cannot claim it.
      if (job.operation === 'consume') await tx.delete('session');
      return { saved };
    }));
  }
  async alarm() {
    await this.state.storage.transaction(async tx => {
      const saved = await tx.get('session');
      if (saved && saved.expires > Date.now()) await tx.setAlarm(saved.expires);
      else await tx.delete('session');
    });
  }
}
