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
type ReleaseArtifact = { platform: Platform; architecture?: string; url: string; sha256?: string; name?: string };
type ReleaseManifest = { version: string; publishedAt?: string; signature?: string; artifacts: ReleaseArtifact[] };

const manifestUrl = 'https://github.com/Somethings1/quizzer/releases/latest/download/release-manifest.json';
const releasesUrl = 'https://github.com/Somethings1/quizzer/releases/latest';
const installers: Record<Platform, string> = {
  macos: 'curl -fsSL https://github.com/Somethings1/quizzer/releases/latest/download/install.sh | sh',
  linux: 'curl -fsSL https://github.com/Somethings1/quizzer/releases/latest/download/install.sh | sh',
  windows: 'irm https://github.com/Somethings1/quizzer/releases/latest/download/install.ps1 | iex',
};
const platformLabel: Record<Platform, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };

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

function isTrustedArtifact(artifact: ReleaseArtifact) {
  try {
    const url = new URL(artifact.url);
    return url.protocol === 'https:' && (url.hostname === 'github.com' || url.hostname.endsWith('.githubusercontent.com'));
  } catch { return false; }
}

export default function Home() {
  const detectedPlatform = useSyncExternalStore(() => () => undefined, detectPlatform, () => 'macos' as Platform);
  const [platformOverride, setPlatformOverride] = useState<Platform>();
  const [copied, setCopied] = useState<Platform | null>(null);
  const [manifest, setManifest] = useState<ReleaseManifest>();
  const [manifestUnavailable, setManifestUnavailable] = useState(false);
  const [sample, setSample] = useState<SampleId>('terraform');
  const [instruction, setInstruction] = useState('Coding questions about Terraform only');

  const platform = platformOverride ?? detectedPlatform;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(manifestUrl, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Release manifest unavailable');
      const value = await response.json() as Partial<ReleaseManifest>;
      if (typeof value.version !== 'string' || !Array.isArray(value.artifacts)) throw new Error('Invalid release manifest');
      setManifest({ ...value, version: value.version, artifacts: value.artifacts.filter(isTrustedArtifact) });
    }).catch(error => { if ((error as Error).name !== 'AbortError') setManifestUnavailable(true); });
    return () => controller.abort();
  }, []);

  const copyInstaller = async (target: Platform) => {
    await navigator.clipboard.writeText(installers[target]);
    setCopied(target);
    window.setTimeout(() => setCopied(null), 1800);
  };
  const artifact = manifest?.artifacts.find(item => item.platform === platform);
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
        <div className="download-status">{manifest ? <><Sparkles /><span><strong>Version {manifest.version}</strong><small>Release manifest loaded · {manifest.artifacts.length} signed artifacts</small></span></> : manifestUnavailable ? <><RefreshCw /><span><strong>Release manifest unavailable</strong><small>Downloads safely fall back to GitHub Releases.</small></span></> : <><RefreshCw className="spin" /><span><strong>Checking latest release</strong><small>Loading artifacts and checksums…</small></span></>}</div>
        <div className="install-list">{(Object.keys(platformLabel) as Platform[]).map(item => {
          const itemArtifact = manifest?.artifacts.find(candidate => candidate.platform === item);
          return <article key={item}>
            <div><Terminal /><span><strong>{platformLabel[item]}</strong><small>{item === 'macos' ? 'macOS 13+ · Intel & Apple silicon' : item === 'windows' ? 'Windows 10/11 x64 · Windows 11 arm64' : 'Current Ubuntu/Fedora-class · x64 & arm64'}</small></span></div>
            <div className="command-row"><code>{installers[item]}</code><Button variant="ghost" size="icon" onClick={() => void copyInstaller(item)} aria-label={`Copy ${platformLabel[item]} installer`}>{copied === item ? <Check /> : <Clipboard />}</Button></div>
            {itemArtifact?.sha256 && <small className="checksum">SHA-256 {itemArtifact.sha256}</small>}
          </article>;
        })}</div>
        <p className="alternatives">Prefer a package manager? Homebrew, winget, AppImage, deb, and rpm builds are published alongside standalone installers. <a href={releasesUrl}>See all releases <ArrowRight /></a></p>
      </div>
    </section>

    <footer><a href="#top" className="brand"><span className="brand-mark">Q</span><span>Quizzer</span></a><p>Local-first, open-source learning.</p><nav><a href="https://github.com/Somethings1/quizzer">Source</a><a href="https://github.com/Somethings1/quizzer/releases">Releases</a><a href="https://github.com/Somethings1/quizzer/blob/main/LICENSE">Apache-2.0</a></nav></footer>
  </main>;
}
