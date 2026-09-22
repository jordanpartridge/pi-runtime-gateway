// Standalone loopback proof: uses installed Prism, does not boot Laravel or call a model.
// Usage: node this-file.mjs GATEWAY_REPOSITORY LARAVEL_VENDOR_AUTOLOAD
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
const [repository, autoload] = process.argv.slice(2);
if (!repository || !autoload) throw new Error('Provide the gateway repository and Laravel vendor/autoload.php paths.');
const { createGateway } = await import(pathToFileURL(resolve(repository, 'server.mjs')));
const { Runtime } = await import(pathToFileURL(resolve(repository, 'lib/runtime.mjs')));
const root = mkdtempSync(resolve(tmpdir(), 'pi-php-client-proof-'));
for (const name of ['success', 'provider-error', 'agent']) mkdirSync(resolve(root, name));
for (const name of ['system.md', 'extension.ts', 'skill.md']) writeFileSync(resolve(root, name), 'Offline protocol proof.');
const profile = { id: 'proof', provider: 'offline-test', model: 'pinned-test-model',
  piBinary: resolve(repository, 'test/fixtures/fake-pi.mjs'), projects: { success: 'success', failure: 'provider-error' },
  maxRuns: 10, startupTimeoutMs: 1500, runTimeoutMs: 4000, cancelGraceMs: 100,
  agentDir: 'agent', extension: 'extension.ts', skill: 'skill.md', systemPrompt: 'system.md', tools: ['read'] };
const stateDir = resolve(root, 'state');
const runtime = new Runtime({ root, profile, stateDir });
const token = randomBytes(32).toString('hex');
const gateway = createGateway({ root, profile, stateDir, runtime, token });
await new Promise(ready => gateway.server.listen(0, '127.0.0.1', ready));
const php = String.raw`
require $argv[2];
$c = new Illuminate\Container\Container; Illuminate\Container\Container::setInstance($c);
$c->instance('config', new Illuminate\Config\Repository(['prism' => ['request_timeout' => 3]]));
Illuminate\Support\Facades\Facade::setFacadeApplication($c);
Illuminate\Support\Facades\Http::swap(new Illuminate\Http\Client\Factory);
$p = new Prism\Prism\Providers\OpenRouter\OpenRouter(apiKey: getenv('OFFLINE_PROOF_TOKEN'), url: $argv[1]);
$make = fn($model) => new Prism\Prism\Text\Request(model: $model, providerKey: 'openrouter',
  systemPrompts: [new Prism\Prism\ValueObjects\Messages\SystemMessage('Review carefully.')], prompt: null,
  messages: [new Prism\Prism\ValueObjects\Messages\UserMessage('Review the fixture.')], maxSteps: 1,
  maxTokens: null, temperature: null, topP: null, tools: [], clientOptions: [], clientRetry: [], toolChoice: null);
$r = $p->text($make('proof/success'));
if ($r->text !== 'Review: Café 👋 is clear.' || $r->usage->promptTokens !== 23)
  throw new RuntimeException('Buffered text/usage mismatch.');
$text = ''; $end = null;
foreach ($p->stream($make('proof/success')) as $e) {
  if ($e instanceof Prism\Prism\Streaming\Events\TextDeltaEvent) $text .= $e->delta;
  if ($e instanceof Prism\Prism\Streaming\Events\StreamEndEvent) $end = $e;
}
if ($text !== $r->text || $end?->finishReason !== Prism\Prism\Enums\FinishReason::Stop || $end?->usage?->promptTokens !== 23)
  throw new RuntimeException('Streaming text/finish/usage mismatch.');
$failed = false;
try { foreach ($p->stream($make('proof/failure')) as $e) {} }
catch (Illuminate\Http\Client\RequestException $e) { $failed = $e->response->status() === 502; }
if (!$failed) throw new RuntimeException('Failed stream was accepted.');
echo json_encode(['installed_prism' => Composer\InstalledVersions::getPrettyVersion('prism-php/prism'), 'buffered_text_and_usage' => 'pass',
  'stream_text_finish_and_usage' => 'pass', 'failed_stream_HTTP502' => 'pass', 'real_model_calls' => 0]).PHP_EOL;
`;
try {
  const env = Object.fromEntries(['HOME', 'PATH', 'LANG'].map(key => [key, process.env[key] || '']));
  const result = await promisify(execFile)('php', ['-r', php,
    `http://127.0.0.1:${gateway.server.address().port}/v1`, resolve(autoload)],
    { timeout: 15000, env: { ...env, OFFLINE_PROOF_TOKEN: token } });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
} catch (error) {
  process.stdout.write(error.stdout || ''); process.stderr.write(error.stderr || ''); process.exitCode = 1;
} finally { await gateway.close(); rmSync(root, { recursive: true, force: true }); }
