'use client';

import Image from 'next/image';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  ArrowRight, BookOpen, BrainCircuit, Check, ChevronRight, CircleCheck, Clipboard, CodeXml, Cpu,
  Database, FileSearch, Gauge, Laptop, LockKeyhole, Network, Plug, RefreshCw, Route, ShieldCheck,
  Sparkles, Terminal, WandSparkles, Zap,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type Platform = 'windows' | 'macos' | 'linux';
type Architecture = 'x64' | 'arm64';
type ArtifactFormat = 'exe' | 'msi' | 'dmg' | 'pkg' | 'zip' | 'appimage' | 'deb' | 'rpm' | 'tar.gz' | 'sea';
type ReleaseArtifact = {
  name: string;
  platform: Platform;
  architecture: Architecture;
  format: ArtifactFormat;
  url: string;
  size: number;
  sha256: string;
  minimumOs: string;
  cli?: true;
};
type ReleaseManifest = {
  schemaVersion: 1;
  version: string;
  channel: 'stable' | 'beta';
  publishedAt: string;
  signatureAlgorithm: 'ed25519';
  publicKeyId: string;
  signature: string;
  artifacts: ReleaseArtifact[];
};

const manifestUrl = 'https://github.com/Somethings1/quizzer/releases/latest/download/release-manifest.json';
const releasesUrl = 'https://github.com/Somethings1/quizzer/releases/latest';
const installers: Record<Platform, string> = {
  macos: 'curl -fsSL https://github.com/Somethings1/quizzer/releases/latest/download/install.sh | sh',
  linux: 'curl -fsSL https://github.com/Somethings1/quizzer/releases/latest/download/install.sh | sh',
  windows: 'irm https://github.com/Somethings1/quizzer/releases/latest/download/install.ps1 | iex',
};
const platformLabel: Record<Platform, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
const preferredFormats: Record<Platform, ArtifactFormat[]> = {
  windows: ['exe', 'msi'],
  macos: ['dmg', 'pkg'],
  linux: ['appimage', 'deb', 'rpm'],
};
const supportedFormats = new Set<ArtifactFormat>(['exe', 'msi', 'dmg', 'pkg', 'zip', 'appimage', 'deb', 'rpm', 'tar.gz', 'sea']);
const maximumArtifactSize = 1024 * 1024 * 1024;

const samples = {
  terraform: { label: 'Terraform field guide', pages: 84, topics: ['State', 'Modules', 'Providers', 'Security'] },
  kubernetes: { label: 'Kubernetes operations', pages: 112, topics: ['Workloads', 'Networking', 'Storage', 'Debugging'] },
  architecture: { label: 'System design notes', pages: 63, topics: ['Caching', 'Queues', 'Databases', 'Reliability'] },
} as const;
type SampleId = keyof typeof samples;

function detectPlatform(): Platform {
  const source = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  if (source.includes('win')) return 'windows';
  if (source.includes('mac')) return 'macos';
  return 'linux';
}

function detectArchitecture(): Architecture | undefined {
  const source = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  if (/\b(?:aarch64|arm64)\b/.test(source)) return 'arm64';
  if (/\b(?:x86_64|x64|win64|amd64)\b/.test(source)) return 'x64';
  return undefined;
}

function normalizeArchitecture(architecture: unknown, bitness: unknown): Architecture | undefined {
  if (typeof architecture !== 'string') return undefined;
  const normalized = architecture.toLowerCase();
  if ((normalized === 'arm' || normalized === 'arm64' || normalized === 'aarch64') && (bitness === undefined || bitness === '64')) return 'arm64';
  if ((normalized === 'x86' || normalized === 'x64' || normalized === 'x86_64' || normalized === 'amd64') && (bitness === undefined || bitness === '64')) return 'x64';
  return undefined;
}

function isTrustedArtifactUrl(artifact: ReleaseArtifact) {
  try {
    const url = new URL(artifact.url);
    const path = url.pathname.split('/');
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.port === ''
      && url.username === '' && url.password === '' && url.search === '' && url.hash === ''
      && path.length === 7 && path[1] === 'Somethings1' && path[2] === 'quizzer'
      && path[3] === 'releases' && path[4] === 'download' && path[5].length > 0
      && decodeURIComponent(path[6]) === artifact.name;
  } catch { return false; }
}

function isReleaseArtifact(value: unknown): value is ReleaseArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const artifact = value as Partial<ReleaseArtifact>;
  return typeof artifact.name === 'string'
    && artifact.name.length <= 128
    && /^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]{0,126}[a-zA-Z0-9])?$/.test(artifact.name)
    && !artifact.name.includes('..')
    && (artifact.platform === 'windows' || artifact.platform === 'macos' || artifact.platform === 'linux')
    && (artifact.architecture === 'x64' || artifact.architecture === 'arm64')
    && typeof artifact.format === 'string' && supportedFormats.has(artifact.format as ArtifactFormat)
    && Number.isSafeInteger(artifact.size) && Number(artifact.size) >= 1 && Number(artifact.size) <= maximumArtifactSize
    && typeof artifact.sha256 === 'string' && /^[a-f0-9]{64}$/.test(artifact.sha256)
    && typeof artifact.minimumOs === 'string' && artifact.minimumOs.length > 0
    && (artifact.cli === undefined || artifact.cli === true)
    && typeof artifact.url === 'string'
    && isTrustedArtifactUrl(artifact as ReleaseArtifact);
}

function selectArtifact(manifest: ReleaseManifest | undefined, platform: Platform, architecture: Architecture | undefined) {
  if (!manifest || !architecture) return undefined;
  const candidates = manifest.artifacts.filter(artifact => artifact.platform === platform
    && artifact.architecture === architecture && artifact.cli !== true);
  return preferredFormats[platform].map(format => candidates.find(artifact => artifact.format === format)).find(Boolean);
}

function formatArtifactSize(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'signature')
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function decodeBase64(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(normalized), character => character.charCodeAt(0));
}

async function verifyReleaseManifest(value: Partial<ReleaseManifest>): Promise<ReleaseManifest> {
  const publicKey = process.env.NEXT_PUBLIC_QUIZZER_RELEASE_PUBLIC_KEY;
  const publicKeyId = process.env.NEXT_PUBLIC_QUIZZER_RELEASE_PUBLIC_KEY_ID;
  if (!publicKey) throw new Error('Release signing key is not configured');
  if (!publicKeyId) throw new Error('Release signing key ID is not configured');
  if (value.schemaVersion !== 1 || typeof value.version !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)
    || (value.channel !== 'stable' && value.channel !== 'beta')
    || typeof value.publishedAt !== 'string' || !Number.isFinite(Date.parse(value.publishedAt))
    || value.signatureAlgorithm !== 'ed25519' || value.publicKeyId !== publicKeyId
    || typeof value.signature !== 'string' || value.signature.length < 40
    || !Array.isArray(value.artifacts) || value.artifacts.length === 0
    || !value.artifacts.every(isReleaseArtifact)) throw new Error('Invalid release manifest');
  const targets = new Set<string>();
  for (const artifact of value.artifacts) {
    const target = `${artifact.platform}:${artifact.architecture}:${artifact.format}`;
    if (targets.has(target)) throw new Error('Release manifest contains duplicate targets');
    targets.add(target);
  }
  const key = await crypto.subtle.importKey('raw', decodeBase64(publicKey), { name: 'Ed25519' }, false, ['verify']);
  const valid = await crypto.subtle.verify({ name: 'Ed25519' }, key, decodeBase64(value.signature), new TextEncoder().encode(canonicalize(value)));
  if (!valid) throw new Error('Release manifest signature is invalid');
  return value as ReleaseManifest;
}

export default function Home() {
  const detectedPlatform = useSyncExternalStore(() => () => undefined, detectPlatform, () => 'macos' as Platform);
  const fallbackArchitecture = useSyncExternalStore(() => () => undefined, detectArchitecture, () => undefined);
  const [highEntropyArchitecture, setHighEntropyArchitecture] = useState<Architecture>();
  const [platformOverride, setPlatformOverride] = useState<Platform>();
  const [copied, setCopied] = useState<Platform | null>(null);
  const [manifest, setManifest] = useState<ReleaseManifest>();
  const [manifestUnavailable, setManifestUnavailable] = useState(false);
  const [sample, setSample] = useState<SampleId>('terraform');
  const [instruction, setInstruction] = useState('Coding questions about Terraform only');

  const platform = platformOverride ?? detectedPlatform;
  const detectedArchitecture = highEntropyArchitecture ?? fallbackArchitecture;
  useEffect(() => {
    type UserAgentData = { getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string; bitness?: string }> };
    const userAgentData = (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData;
    if (!userAgentData?.getHighEntropyValues) return;
    let active = true;
    void userAgentData.getHighEntropyValues(['architecture', 'bitness']).then(values => {
      const architecture = normalizeArchitecture(values.architecture, values.bitness);
      if (active && architecture) setHighEntropyArchitecture(architecture);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(manifestUrl, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Release manifest unavailable');
      setManifest(await verifyReleaseManifest(await response.json() as Partial<ReleaseManifest>));
    }).catch(error => { if ((error as Error).name !== 'AbortError') setManifestUnavailable(true); });
    return () => controller.abort();
  }, []);

  const copyInstaller = async (target: Platform) => {
    await navigator.clipboard.writeText(installers[target]);
    setCopied(target);
    window.setTimeout(() => setCopied(null), 1800);
  };
  const artifact = selectArtifact(manifest, platform, detectedArchitecture);
  const downloadUrl = artifact?.url ?? releasesUrl;
  const demo = useMemo(() => {
    const lower = instruction.toLowerCase();
    const coding = /code|coding|implement|script/.test(lower);
    const advanced = /advanced|hard|deep|architect/.test(lower);
    const namedTopic = samples[sample].topics.find(topic => lower.includes(topic.toLowerCase()));
    return {
      scope: namedTopic ? namedTopic : lower.includes('only') ? samples[sample].topics[0] : 'Balanced coverage',
      difficulty: advanced ? 'Advanced' : 'Adaptive',
      questions: coding ? { choice: 10, blank: 2, reasoning: 3, coding: 5 } : { choice: 14, blank: 3, reasoning: 3, coding: 0 },
      retrieval: lower.includes('only') ? 'Strict topic filter + hybrid search' : 'Hybrid search + diverse coverage',
    };
  }, [instruction, sample]);

  return <main>
    <header className="site-header">
      <a href="#top" className="brand" aria-label="Quizzer home"><span className="brand-mark">Q</span><span>Quizzer</span></a>
      <nav aria-label="Primary navigation"><a href="#workflow">How it works</a><a href="#privacy">Privacy</a><a href="#profiles">Profiles</a><a href="#download">Download</a><a href="https://github.com/Somethings1/quizzer">GitHub</a></nav>
    </header>

    <section id="top" className="hero">
      <div className="hero-copy">
        <div className="eyebrow"><LockKeyhole /> Local-first learning</div>
        <h1>Your documents.<br /><span>Your questions.</span></h1>
        <p className="hero-lede">Build challenging, source-grounded quizzes from PDFs, notes, and Markdown—without giving up control of your library or your AI provider.</p>
        <div className="hero-actions">
          <a className={cn(buttonVariants({ size: 'lg' }), 'download-button')} href={downloadUrl}>
            <Laptop /> Download for {platformLabel[platform]} <ChevronRight />
          </a>
          <a className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'github-button')} href="https://github.com/Somethings1/quizzer"><CodeXml /> View source</a>
        </div>
        <div className="installer" aria-label={`${platformLabel[platform]} installation command`}>
          <code>{installers[platform]}</code>
          <Button variant="ghost" size="icon" onClick={() => void copyInstaller(platform)} aria-label="Copy installer command">{copied === platform ? <Check /> : <Clipboard />}</Button>
        </div>
        <div className="platform-switcher" aria-label="Choose operating system">
          {(Object.keys(platformLabel) as Platform[]).map(item => <Button key={item} size="xs" variant={item === platform ? 'secondary' : 'ghost'} onClick={() => setPlatformOverride(item)}>{platformLabel[item]}</Button>)}
        </div>
        <p className="hero-meta">No Node, Python, or Git required · x64 and arm64 · Apache-2.0</p>
      </div>
      <div className="product-frame" aria-label="Quizzer application preview">
        <div className="window-bar"><i /><i /><i /><span>Quizzer · Create test</span></div>
        <Image src="/quiz-creation-dark.jpg" width={1920} height={1200} priority alt="Quizzer creating a quiz from selected source documents" />
        <div className="local-badge"><LockKeyhole /><span><strong>Library stays local</strong><small>You approve every AI route</small></span></div>
      </div>
    </section>

    <section id="workflow" className="section workflow-section">
      <div className="section-heading"><p className="section-kicker">Document to quiz</p><h2>Spend less time preparing.<br />More time retrieving.</h2><p>Quizzer extracts the structure, builds a reusable local index, and validates every question against your source.</p></div>
      <div className="workflow-grid">
        {[['01', 'Import once', 'Add PDF, Markdown, or text. Page-aware extraction preserves headings, code, tables, and image anchors.'], ['02', 'Set the learning goal', 'Select sources and add an instruction like “diagnostic coding questions about Terraform state only.”'], ['03', 'Practice with evidence', 'Take the quiz, inspect feedback and citations, then ask follow-up questions without searching the full library.']].map(([number, title, description]) => <article key={number}><span>{number}</span><h3>{title}</h3><p>{description}</p></article>)}
      </div>
      <div className="library-preview"><Image src="/document-library-light.jpg" width={1920} height={1200} alt="Quizzer document library with searchable tags and extracted content" /><div className="preview-note"><FileSearch /><strong>One local library</strong><span>Reuse the same indexed sources across every test and chat.</span></div></div>
    </section>

    <section className="section demo-section">
      <div className="section-heading left"><p className="section-kicker">Try the configuration</p><h2>Tell Quizzer what matters.</h2><p>This demonstration runs entirely in your browser. It never calls an AI provider.</p></div>
      <div className="demo-shell">
        <div className="demo-form">
          <p className="demo-label">Sample source</p>
          <div className="sample-options">{(Object.keys(samples) as SampleId[]).map(item => <Button key={item} variant={sample === item ? 'default' : 'outline'} onClick={() => setSample(item)}>{samples[item].label}</Button>)}</div>
          <label htmlFor="learning-goal">Custom learning instruction</label>
          <Input id="learning-goal" value={instruction} onChange={event => setInstruction(event.target.value)} placeholder="What should the quiz emphasize?" />
          <p><LockKeyhole /> Preview only · no document or instruction leaves this page</p>
        </div>
        <div className="demo-result" aria-live="polite">
          <div className="demo-result-title"><WandSparkles /><span><small>Proposed quiz</small><strong>{samples[sample].label}</strong></span></div>
          <dl><div><dt>Focus</dt><dd>{demo.scope}</dd></div><div><dt>Difficulty</dt><dd>{demo.difficulty}</dd></div><div><dt>Retrieval</dt><dd>{demo.retrieval}</dd></div></dl>
          <div className="question-mix">{Object.entries(demo.questions).map(([type, count]) => <div key={type}><i style={{ width: `${Math.max(8, count / 20 * 100)}%` }} /><span>{type}</span><strong>{count}</strong></div>)}</div>
          <div className="demo-ready"><CircleCheck /> Grounding and duplicate checks enabled</div>
        </div>
      </div>
    </section>

    <section id="privacy" className="section dark-section">
      <div className="section-heading left"><p className="section-kicker">Private by design</p><h2>Your library is not a subscription.</h2><p>Documents, quizzes, checkpoints, and indexes live on your computer. Choose exactly how generation happens.</p></div>
      <div className="feature-grid">
        <Card><CardHeader><ShieldCheck /><CardTitle>Local data</CardTitle><CardDescription>Original files and derived indexes stay in OS application data. Secrets never enter exports, backups, or diagnostics.</CardDescription></CardHeader></Card>
        <Card><CardHeader><Route /><CardTitle>Your provider route</CardTitle><CardDescription>Use a signed-in agent, an API, Ollama, or a compatible local endpoint. Paid or less-private failover always needs approval.</CardDescription></CardHeader></Card>
        <Card><CardHeader><RefreshCw /><CardTitle>Quota-safe switching</CardTitle><CardDescription>Accepted questions are checkpointed. Switch models after a quota error and regenerate only unfinished coverage slots.</CardDescription></CardHeader></Card>
        <Card><CardHeader><Database /><CardTitle>Durable by default</CardTitle><CardDescription>Indexing and generation resume after app, network, or machine restarts without duplicating committed work.</CardDescription></CardHeader></Card>
      </div>
    </section>

    <section id="profiles" className="section profile-section">
      <div className="section-heading"><p className="section-kicker">Fits your hardware</p><h2>Start light. Scale when it helps.</h2><p>Quizzer scans CPU, memory, acceleration, and disk, then recommends a profile. Every component remains overridable.</p></div>
      <div className="profile-grid">
        <Card><CardHeader><Zap /><CardTitle>Lite</CardTitle><CardDescription>CPU-only baseline</CardDescription></CardHeader><CardContent><ul><li>Sparse FTS5 search</li><li>Basic PDF and text extraction</li><li>Remote or agent generation</li><li>No model downloads</li></ul></CardContent></Card>
        <Card className="recommended"><span className="recommended-label">Recommended for most</span><CardHeader><Gauge /><CardTitle>Balanced</CardTitle><CardDescription>Useful local intelligence</CardDescription></CardHeader><CardContent><ul><li>OCR on demand</li><li>Local MiniLM embeddings</li><li>Hybrid retrieval + reranking</li><li>Optional small local model</li></ul></CardContent></Card>
        <Card><CardHeader><Cpu /><CardTitle>Max</CardTitle><CardDescription>High-quality local stack</CardDescription></CardHeader><CardContent><ul><li>Visual and Marker extraction</li><li>Multilingual retrieval</li><li>Multi-query and HyDE</li><li>Managed local generation</li></ul></CardContent></Card>
      </div>
    </section>

    <section className="section capabilities-section">
      <div className="capability-intro"><p className="section-kicker">Built for real learning</p><h2>Control the questions.<br />Trust the evidence.</h2><p>Simple and Advanced modes share the same engine. Change how much you see—not what Quizzer can do.</p><a href="https://github.com/Somethings1/quizzer">Explore the architecture <ArrowRight /></a></div>
      <div className="capability-list">
        <article><BookOpen /><div><h3>Custom instructions & Prompt Studio</h3><p>Save a learning goal with each test. Clone and version generation, grading, and retrieval templates without weakening source isolation.</p></div></article>
        <article><Network /><div><h3>Hybrid multimodal RAG</h3><p>Combine sparse and dense retrieval, reranking, parent context, page citations, figures, and OCR—with clear refusal when evidence is weak.</p></div></article>
        <article><BrainCircuit /><div><h3>Validated coverage</h3><p>Check grounding, schema, difficulty, distractors, semantic duplicates, and instruction adherence before a question reaches your test.</p></div></article>
        <article><Plug /><div><h3>Open plugin contract</h3><p>Swap extraction, OCR, embedding, vector index, reranking, and generation components through signed, out-of-process plugins.</p></div></article>
      </div>
    </section>

    <section id="download" className="section download-section">
      <div className="download-panel">
        <div><p className="section-kicker">Get Quizzer</p><h2>One command. Your whole study workspace.</h2><p>Per-user installers verify checksums, add the CLI to PATH, register the desktop app, and open onboarding.</p></div>
        <div className="download-status">{manifest ? <><Sparkles /><span><strong>Version {manifest.version}</strong><small>Verified release manifest · {manifest.artifacts.length} signed artifacts</small></span></> : manifestUnavailable ? <><RefreshCw /><span><strong>Verified release unavailable</strong><small>Downloads safely fall back to GitHub Releases.</small></span></> : <><RefreshCw className="spin" /><span><strong>Checking latest release</strong><small>Verifying artifacts and checksums…</small></span></>}</div>
        <div className="install-list">{(Object.keys(platformLabel) as Platform[]).map(item => {
          const itemArtifact = selectArtifact(manifest, item, detectedArchitecture);
          return <article key={item}>
            <div><Terminal /><span><strong>{platformLabel[item]}</strong><small>{item === 'macos' ? 'macOS 13+ · Intel & Apple silicon' : item === 'windows' ? 'Windows 10/11 x64 · Windows 11 arm64' : 'Current Ubuntu/Fedora-class · x64 & arm64'}</small></span></div>
            <div className="command-row"><code>{installers[item]}</code><Button variant="ghost" size="icon" onClick={() => void copyInstaller(item)} aria-label={`Copy ${platformLabel[item]} installer`}>{copied === item ? <Check /> : <Clipboard />}</Button></div>
            {itemArtifact && <><small className="artifact-details">{itemArtifact.name} · {formatArtifactSize(itemArtifact.size)} · {itemArtifact.minimumOs}</small><small className="checksum">SHA-256 {itemArtifact.sha256}</small></>}
          </article>;
        })}</div>
        <p className="alternatives">No npm, Homebrew, WinGet, Node.js, Python, or Git is required. The commands above download verified artifacts directly from <a href={releasesUrl}>GitHub Releases <ArrowRight /></a></p>
      </div>
    </section>

    <footer><a href="#top" className="brand"><span className="brand-mark">Q</span><span>Quizzer</span></a><p>Local-first, open-source learning.</p><nav><a href="https://github.com/Somethings1/quizzer">Source</a><a href="https://github.com/Somethings1/quizzer/releases">Releases</a><a href="https://github.com/Somethings1/quizzer/blob/main/LICENSE">Apache-2.0</a></nav></footer>
  </main>;
}
