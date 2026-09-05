# @gtrabanco/pi-nan-provider

Proveedor de modelos de [NaN Builders](https://nan.builders) + puentes MCP para [pi](https://github.com/earendil-works/pi). Registra el proveedor `nan` vía `pi.registerProvider()` usando la API OpenAI-compatible de NaN (`https://api.nan.builders/v1`, LiteLLM por debajo), y conecta las herramientas MCP de NaN en pi con `pi.registerTool()`.

**Documentación en español** (este archivo) · [Documentation in English](README.md)

Consigue tu API key de NaN (enlace de referidos): **<https://cloud.nan.builders/r/7GK06FX8>**

## Cómo funciona

Catálogo de modelos de dos capas, nunca una sola:

1. **Fallback generado** (`scripts/models.generated.ts`, versionado): se genera en build desde [models.dev](https://models.dev) (proveedor `nan`). Es la configuración *servida* por NaN — si el modelo subyacente soporta 2M de contexto pero NaN lo sirve a 1M, el catálogo dice lo que tu clave obtiene, no el máximo teórico del modelo. Cada valor traza a su fuente, y la entrada cruda completa de models.dev se conserva por modelo (`extras`) para no perder ninguna propiedad documentada. Nada se inventa: las entradas incompletas en models.dev se omiten y se marcan.
2. **Fetch en vivo de `/models`**: el endpoint de NaN solo devuelve los `id` de los modelos, así que se usa para confirmar qué IDs puede llamar tu clave. Los IDs en vivo se combinan con los datos de capacidades generados; un ID en vivo sin datos generados se conserva con límites conservadores de ejemplo (nunca capacidades fabricadas). Ante timeout (~3s), fallo de red, error de auth o respuesta inutilizable, se usa el catálogo generado y el arranque nunca se bloquea.

**Detección de tier:** con clave configurada, la lista en vivo de `/models` es la autoridad — lista exactamente los modelos que tu membresía de NaN puede llamar, y los modelos ausentes se filtran del conjunto disponible (`filterModels`). Eso incluye los modelos con tier: un modelo de tier premium simplemente no aparece si tu clave no lo tiene. Sin clave (o si falla el fetch), se muestra el catálogo generado completo.

El registro es síncrono a propósito: el catálogo generado está disponible al instante, y el runtime de Models de pi dirige el refresco en vivo (refresco de red en el arranque interactivo y periódico, solo caché en el registro), persistiendo el overlay entre ejecuciones.

## Instalación

```bash
pi install npm:@gtrabanco/pi-nan-provider
# o, desde git:
pi install git:github.com/gtrabanco/pi-nan-provider
# o, para probarlo sin instalar:
pi -e npm:@gtrabanco/pi-nan-provider
```

Después reinicia pi (o `/reload`). Verifica con:

```bash
pi --list-models nan
```

## Autenticación

`resolve()` comprueba primero la credencial almacenada y después recurre a la variable de entorno correspondiente — la misma precedencia que usan los proveedores nativos de pi. No hace falta ningún prompt si la env var está configurada. Las claves nunca se hardcodean ni se loguean.

**Opción 1 — variable de entorno (rápida):** con el paquete instalado basta con exportar la clave para tener NaN configurado:

```bash
export NAN_API_KEY="sk-tu-clave-aqui"
```

**Opción 2 — `/login` (persistente):** ejecuta `/login nan` en pi y pega tu clave; se guarda en `~/.pi/agent/auth.json`.

**Opción 3 — `~/.pi/agent/auth.json` directamente:**

```json
{
  "nan": { "type": "api_key", "key": "sk-tu-clave-aqui" }
}
```

Consigue una clave en la [plataforma NaN](https://cloud.nan.builders/r/7GK06FX8) (ajustes de usuario → API Keys; enlace de referidos). La clave es personal e intransferible.

## Puentes MCP

pi no incluye cliente MCP a propósito ("It intentionally does not include built-in MCP" — `docs/usage.md` de pi). Este paquete conecta servidores MCP dentro de pi como herramientas nativas personalizadas, de modo que el LLM las llama como cualquier herramienta integrada.

Ambos puentes están **activados y perezosos por defecto**, y se configuran con el comando `/nan-mcp` que trae este paquete (pi no tiene comando `/mcp` propio — no tiene cliente MCP en absoluto — así que el comando se llama `/nan-mcp`):

| Comando | Efecto |
|---|---|
| `/nan-mcp status` | Estado de ambos puentes y de dónde sale cada interruptor (env / persistido / por defecto) |
| `/nan-mcp enable [target]` | Activa un puente — o ambos si no das target — y lo persiste en `<agentDir>/nan-provider.json` (p. ej. `~/.pi/agent/nan-provider.json`); las herramientas se registran al instante en la sesión actual |
| `/nan-mcp disable [target]` | Desactiva persistentemente; pi no tiene `unregisterTool`, así que las herramientas ya registradas siguen hasta reiniciar; las sesiones futuras no las registran |

Targets: `web-search` (puente oficial; alias `search`) y `nan-mcp-server` (puente de media de la comunidad; alias `media`). Ejemplo: `/nan-mcp enable nan-mcp-server`. Las variables de entorno explícitas tienen prioridad sobre los toggles persistidos (ver tabla inferior).

### 1. Servidor MCP oficial de NaN (por defecto: activado, perezoso)

El servidor MCP remoto oficial de NaN ([`https://api.nan.builders/mcp`](https://nan.builders/docs/api), JSON-RPC 2.0 sobre HTTP, misma clave `sk-`, mismo límite de tasa/cuota/concurrencia que la API REST) se conecta como:

- **`nan_web_search(query, count?, freshness?, fetch_content?)`** — búsqueda web vía NaN. La llamada HTTP solo ocurre cuando se invoca la herramienta.

El servidor es un registro en crecimiento (descubrible con `tools/list`); este paquete conecta por ahora la herramienta documentada `web_search` y mantiene un helper genérico `callNanMcpTool()` para herramientas futuras.

### 2. Servidor MCP de media de la comunidad (por defecto: activado, perezoso)

[`nan-mcp-server`](https://github.com/luciferfran/nan-mcp-server) es un servidor MCP stdio que expone las herramientas de media de NaN: generación/edición de imágenes (flux-2-klein), TTS (kokoro) y STT (whisper). Como pi no tiene cliente MCP, este paquete lo conecta como herramientas de pi mediante un cliente MCP stdio mínimo:

- **Activado por defecto**, conmutado persistentemente con `/nan-mcp enable|disable nan-mcp-server` (o `media`), o por sesión con `NAN_MEDIA_MCP` (cualquier valor explícito — p. ej. `NAN_MEDIA_MCP=0` — tiene prioridad sobre el toggle persistido).
- **Perezoso (lazy)**: el proceso del servidor MCP se lanza *por cada llamada* y se termina justo después. No arranca ni conecta nada a menos que se invoque realmente generación de audio/imagen/transcripción.
- **Configuración**: `NAN_API_KEY` se reenvía automáticamente (la misma clave del proveedor); los ficheros generados van a `~/nan-mcp-output/` (por defecto del servidor, configurable con `NAN_OUTPUT_DIR`).

| Herramienta | Propósito |
|---|---|
| `nan_generate_image(prompt, size?, n?, seed?, guidance?, outputName?)` | Generar una imagen (flux-2-klein) |
| `nan_edit_image(prompt, images, size?, n?, seed?, guidance?, outputName?)` | Editar una imagen imagen→imagen (flux-2-klein) |
| `nan_text_to_speech(text, voice?, format?, speed?, outputName?)` | Sintetizar audio (kokoro) |
| `nan_list_voices()` | Listar voces kokoro por idioma |
| `nan_speech_to_text(file, language?, verbose?)` | Transcribir audio (whisper) |

Variables de entorno:

| Variable | Por defecto | Significado |
|---|---|---|
| `NAN_MEDIA_MCP` | — | Override por sesión del puente de media: cualquier valor explícito (incl. `0`) gana al toggle persistido de `/nan-mcp`; sin definir → persistido/por defecto |
| `NAN_MEDIA_MCP_VERSION` | `1.0.7` | Versión del servidor fijada para `npx -y nan-mcp-server@<v>` (recomendación de supply-chain del propio proyecto) |
| `NAN_MEDIA_MCP_COMMAND` | — | Comando personalizado completo, p. ej. `bunx nan-mcp-server@1.0.7` |
| `NAN_MEDIA_MCP_TIMEOUT_MS` | `120000` | Timeout por llamada; el proceso se mata al expirar |
| `NAN_MCP_TOOLS` | — | Override por sesión del puente oficial: `0`/`false`/`off` desactiva `nan_web_search`; sin definir → persistido/por defecto |

## Modelos

Catálogo base (de models.dev, proveedor `nan`, obtenido 2026-09-04 — límites *servidos* por NaN, no máximos teóricos):

| Modelo | Contexto | Máx. salida | Entrada | Razonamiento |
|---|---|---|---|---|
| `qwen3.6` | 262,144 | 65,536 | texto, imagen | sí |
| `gemma4` | 262,144 | 32,768 | texto, imagen | sí |
| `deepseek-v4-flash` | 1,000,000 | 384,000 | texto, imagen | sí |
| `mimo-v2.5` | 1,048,576 | 131,072 | texto, imagen | sí |
| `glm5.2` | 500,000 | 131,072 | texto | sí |
| `glm5.3-flash` | 1,000,000 | 131,072 | texto, imagen | sí |
| `qwen3.8-flash` | 1,000,000 | 131,072 | texto, imagen | sí |

Notas (grabadas por entrada en `scripts/models.generated.ts`):

- La ventana de contexto de `qwen3.8-flash` está confirmada por el mantenedor en 1M (2026-09-05); models.dev y los docs de NaN aún listaban 262,144 en esa fecha. Este tipo de divergencias se registran como `MANUAL_OVERRIDES` en tiempo de build (con procedencia) en `scripts/manual-overrides.ts` — añade una ahí en vez de editar el fichero generado.

- `deepseek-v4-flash` incluye entrada de imagen porque NaN sirve la variante Vision-Exp ([docs de NaN](https://nan.builders/docs/models)); models.dev la lista como solo texto.
- `mimo-v2.5` es omnimodal (texto/imagen/audio) en NaN, pero el tipo de modelo de pi solo representa entrada texto/imagen, así que el audio se omite en `input`.
- NaN factura por cuota de membresía, que models.dev reporta como coste cero por token — el coste mostrado por pi será $0.
- Compat (`supportsDeveloperRole: false`, `supportsReasoningEffort: true`, `supportsUsageInStreaming: true`, `maxTokensField: "max_tokens"`) coincide con la config LiteLLM probada en batalla que este paquete reemplaza; el ejemplo de los docs de NaN (`supportsDeveloperRole: true`) no está probado.
- **Tier/cuota**: qué modelos puedes llamar lo decide tu membresía de NaN. Con clave, el fetch en vivo refleja exactamente eso (ver *Cómo funciona* — detección de tier). El GLM 5.3 de tier premium no está en el proveedor `nan` de models.dev; solo está `glm5.3-flash`.

### Relación con `~/.pi/agent/models.json`

Este paquete reemplaza el bloque `nan` manual de `~/.pi/agent/models.json` (el [ejemplo pi](https://nan.builders/docs/examples) de los docs de NaN). Si conservas ese bloque, ten en cuenta que **models.json se compone por encima de los proveedores registrados** — el fichero estático gana sobre este paquete. Elimina la entrada `nan` de `models.json` (conserva `defaultProvider`/`defaultModel` en `settings.json` si los usas) para usar el catálogo en vivo de este paquete. Los topes de salida por petición pueden seguir configurándose ahí o vía `params` del modelo.

## Compatibilidad con versiones de pi

Verificado contra pi **0.83.0**, **0.84.4** y la línea 0.85 (`registerProvider(provider)`, `registerProvider(name, config)`, `registerTool` y `modelRegistry.getApiKeyForProvider` presentes en ambas; el entrypoint compat de pi-ai reexporta la fábrica de la API openai-completions en 0.83 y 0.84 por igual). La extensión degrada con elegancia entre versiones:

- **Ruta nativa**: Provider completo con auth credencial-almacenada-primero-then-env, overlay de catálogo en vivo y filtrado por tier.
- **Fallback legacy**: si el overload nativo de Provider es rechazado (o la construcción del proveedor falla), el registro cae a la forma legacy documentada `(name, config)` con el mismo catálogo generado y auth por env `$NAN_API_KEY` (la auth por credencial almacenada es una limitación del camino legacy, no un cambio silencioso).
- **Puentes MCP**: se omiten por completo en runtimes sin `registerTool`; los proveedores se registran igualmente.
- **Entrada asíncrona**: pi espera las factorías de extensión en 0.83 y 0.84 por igual, así que la resolución de la API de streaming durante el registro es transparente.
- `peerDependencies` es `>=0.83.0` sin límite superior (incluidos los forks en 0.83).
- **Imports de pi-ai en la extensión**: solo se importa estáticamente el root `@earendil-works/pi-ai`. El loader de extensiones de pi aliasa ese especificador al entrypoint compat; los imports por subruta (p. ej. `@earendil-works/pi-ai/api/openai-completions.lazy`) reciben el alias como prefijo y no resuelven, lo que rompe la carga de toda la extensión. Protegido por `test/extension-load.test.ts`.

## helmcode

La fábrica compartida (`src/provider-factory.ts`) es agnóstica del proveedor, pero `helmcode` **no está registrado**: no existe una URL base ni fuente de capacidades confirmadas (ausente de models.dev y de los docs de NaN), y este repo no fabrica datos de proveedores. Cuando se confirme un endpoint, registrarlo es una entrada en `src/providers.ts` más datos de catálogo — sin una segunda implementación. Un test de contrato (`factory is shared`) ya ejercita un segundo proveedor por el mismo camino de código.

## Desarrollo

```bash
bun install
bun run generate-models   # regenerar el catálogo fallback desde models.dev (pre-publish)
bun test                  # tests unitarios + integración (fetch, auth, puentes MCP, compat)
bun run typecheck         # typecheck vía bunx (tsc local, se autoinstala si falta)
```

`prepublishOnly` ejecuta generación + tests + typecheck. El typecheck resuelve `tsc` vía `bunx` porque `bun publish` ejecuta los scripts de ciclo de vida sin `node_modules/.bin` en el PATH (un `tsc` pelado falla ahí con exit 127). Las releases siguen semver estricto (ver `AGENTS.md`); CI publica cuando un merge a main cambia código y la versión. Ver `CONTRIBUTING.md` para el flujo completo de contribución.