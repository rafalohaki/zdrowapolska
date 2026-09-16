// Dev runner: backend (bun --hot) + frontend (vite) w jednym poleceniu.
// Wcześniej `bun run dev:backend & bun run dev:frontend` po Ctrl+C zostawiało
// backend jako osierocony proces na porcie 2363.
const procs = [
  Bun.spawn(['bun', '--hot', 'server/index.ts'], { stdout: 'inherit', stderr: 'inherit' }),
  Bun.spawn(['bunx', 'vite'], { stdout: 'inherit', stderr: 'inherit' }),
];

const shutdown = () => {
  for (const p of procs) p.kill();
};
process.on('SIGINT', () => {
  shutdown();
  process.exit(130);
});
process.on('SIGTERM', () => {
  shutdown();
  process.exit(143);
});

// padnie jeden → ubijamy drugiego (nie ma sensu vite bez backendu)
await Promise.race(procs.map((p) => p.exited));
shutdown();
