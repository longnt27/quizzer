from pathlib import Path

path = Path('src/components/DocumentView.tsx')
text = path.read_text()
old = """      setIndexStatus(response.status);
      message.success('Document indexed for retrieval');"""
new = """      setIndexStatus(response.status);
      if (response.status.dense?.enabled && response.status.dense.status === 'unavailable') {
        const detail = response.status.dense.issue?.message || 'The configured embedding provider did not return a usable dense index.';
        message.warning(`Sparse index rebuilt for ${document.name}; dense indexing failed: ${detail}`);
      } else {
        message.success(`Indexed ${document.name} for retrieval`);
      }"""
if old not in text:
    raise SystemExit('index result block missing')
text = text.replace(old, new, 1)
old = """        message={indexStatus.dense.status === 'ready'
          ? `Dense retrieval ready · ${indexStatus.dense.embeddingModel}`
          : indexStatus.dense.status === 'unavailable' ? 'Dense retrieval is unavailable; sparse search remains ready' : 'Dense retrieval will be built during indexing'}
        description={indexStatus.dense.status === 'unavailable' ? 'Quizzer will continue using keyword search for this document.' : undefined} />}"""
new = """        message={indexStatus.dense.status === 'ready'
          ? `Dense retrieval ready · ${indexStatus.dense.embeddingModel}`
          : indexStatus.dense.status === 'unavailable' ? `Dense retrieval unavailable · ${indexStatus.dense.embeddingModel}` : 'Dense retrieval will be built during indexing'}
        description={indexStatus.dense.status === 'unavailable'
          ? `${indexStatus.dense.issue?.message || 'The configured embedding provider failed.'} Sparse retrieval remains ready for ${document.name}. Reindex actions on this page affect only this document; dense provider health is shared across the library.`
          : undefined} />}"""
if old not in text:
    raise SystemExit('dense alert block missing')
text = text.replace(old, new, 1)
path.write_text(text)
Path('.github/workflows/issue-161-patch.yml').unlink(missing_ok=True)
Path('scripts/issue161_patch.py').unlink(missing_ok=True)
