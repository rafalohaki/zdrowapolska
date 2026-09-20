/**
 * Powiadomienia o zmianach kolejek — Discord incoming webhook.
 * POST /webhooks/{id}/{token} z {username, embeds, allowed_mentions}
 * (docs: discord.com/developers/docs/resources/webhook#execute-webhook —
 * allowed_mentions: {parse: []} blokuje @everyone z treści generowanej).
 */

export type QueueChange = {
  benefit: string;
  province: string;
  locality: string;
  oldTotal: number;
  newTotal: number;
};

const MAX_LINES = 10;

async function postDiscord(embed: { title: string; description: string; color: number }): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'ZdrowaPolska',
        allowed_mentions: { parse: [] },
        embeds: [{ ...embed, timestamp: new Date().toISOString() }],
      }),
      signal: AbortSignal.timeout(8000),
    });
    // wait=false (domyślnie) → 204; błąd tylko logujemy — sync nie może wywalić się przez webhook
    if (!res.ok) console.error(`[notify] discord webhook HTTP ${res.status}`);
  } catch (err) {
    console.error('[notify] discord webhook failed:', err);
  }
}

/** Alarm o awarii (np. padnięty sync) — czerwony embed, bez @everyone. */
export async function notifyError(title: string, detail: string): Promise<void> {
  await postDiscord({ title, description: detail.slice(0, 4000), color: 0xef4444 });
}

export async function notifyQueueChanges(changes: QueueChange[]): Promise<void> {
  if (!process.env.DISCORD_WEBHOOK_URL || changes.length === 0) return;

  const lines = changes.slice(0, MAX_LINES).map((ch) => {
    const delta = ch.newTotal - ch.oldTotal;
    const pct = ch.oldTotal > 0 ? Math.round((delta / ch.oldTotal) * 100) : 0;
    const dir = delta > 0 ? '↑' : '↓';
    return `${dir} **${ch.benefit}**${ch.locality ? ` (${ch.locality})` : ''} · woj. ${ch.province}: ${ch.oldTotal} → ${ch.newTotal} os. (${pct > 0 ? '+' : ''}${pct}%)`;
  });
  if (changes.length > MAX_LINES) lines.push(`…i ${changes.length - MAX_LINES} innych zmian`);

  await postDiscord({
    title: 'Zmiany w kolejkach NFZ (synchronizacja)',
    description: lines.join('\n'),
    color: 0x059669,
  });
}
