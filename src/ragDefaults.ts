/**
 * Valores padrão e caminhos do RAG, resolvidos em relação a este módulo.
 *
 * A extensão vetorial e o modelo de embedding não dependem do CWD do
 * consumidor: quem importa `@erik-castro/ollamatask/ragDefaults` recebe o
 * caminho absoluto do `bin/vector.so` sem precisar calcular relativos ao
 * próprio projeto.
 */

const fromUrl = (url: URL): string => decodeURIComponent(url.pathname);

/** Caminho absoluto da extensão vetorial (`bin/vector.so`). */
export const RAG_VECTOR_EXTENSION_PATH = fromUrl(
  new URL("../bin/vector.so", import.meta.url),
);

/** Modelo de embedding padrão (768 dims via Ollama). */
export const RAG_DEFAULT_EMBED_MODEL = "nomic-embed-text";