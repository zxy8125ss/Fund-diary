// 在临时副本里试跑晚间批次，只把快照里的快讯和消息面摘要拷回 probe/，不动正式数据
import { execSync } from 'node:child_process';
execSync('rm -rf /tmp/fd && mkdir /tmp/fd && cp -r scripts data /tmp/fd/ && mkdir -p probe/out', { stdio: 'inherit' });
try { execSync('node scripts/run.mjs', { cwd: '/tmp/fd', stdio: 'inherit', env: { ...process.env, NOW_MS: String(Date.parse('2026-10-07T13:40:00Z')) } }); } catch (e) { console.error(e.message); }
execSync('cp -r /tmp/fd/data/snapshots /tmp/fd/data/digests /tmp/fd/data/predictions /tmp/fd/data/triggers probe/out/ 2>/dev/null || true; ls -R probe/out > probe/result.json', { stdio: 'inherit', shell: '/bin/bash' });
