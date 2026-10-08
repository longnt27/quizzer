# Local synthesis safety and review status

A loopback URL alone does not prove that inference is local: Ollama can expose remote-backed models through its local API. Before sending any document prompt, the synthesizer checks `/api/tags` and `/api/show`, rejects remote/cloud metadata and cloud-style model names, and requires a local GGUF format plus model architecture metadata. It does not pull a model. The server must still be trusted; a malicious server can lie about its metadata. Disable cloud functionality at the Ollama server or enforce network isolation when local-only processing is required.

The new local-model-alias regression failed before the guard existed and passed after it was added. This change affects optional synthesis only and does not alter the already measured extraction/BM25 results.

No model-based synthesis run is claimed in this PR. Deterministic controlled-world generation DID run and produced the committed PDFs and oracle labels. The source-conditioned model tool produces candidates, not human-certified gold. Retain source hashes, prompt/model identities, rejected-candidate logs, and actual human review before making real-course quality claims.

Review to date is author self-review, not independent code review or human dataset annotation.
