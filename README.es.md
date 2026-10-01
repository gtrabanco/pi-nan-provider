# @gtrabanco/pi-nan-provider

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-0.11.0-blue)](https://github.com/gtrabanco/pi-nan-provider/releases)

[NaN Builders](https://nan.builders) model provider + MCP nativo para [pi](https://github.com/earendil-works/pi). 

Registra el proveedor `nan` vía `pi.registerProvider()` usando la API OpenAI-compatible de NaN (`https://api.nan.builders/v1`), y registra servidores MCP nativos con `pi.registerMcpServer()`.

---

### ⚡ Inicio Rápido

1. **Consigue tu API Key**: [Reclama tu API key de NaN aquí](https://cloud.nan.builders/r/7GK06FX8) (enlace de referidos).
2. **Instala**:
   ```bash
   pi install npm:@gtrabanco/pi-nan-provider
   ```
3. **Autentica**:
   ```bash
   export NAN_API_KEY="sk-tu-clave-aqui"
   ```
4. **Verifica**:
   ```bash
   pi --list-models nan
   ```

---

**Documentación en español** (este archivo) · [Docs in English](README.md)

## ⚙️ Cómo funciona

El proveedor utiliza un **catálogo de modelos de dos capas** para garantizar la fiabilidad:

| Capa | Fuente | Propósito |
| :--- | :--- | :--- |
| **1. Fallback generado** | `scripts/models.generated.ts` | Snapshot en tiempo de build desde [models.dev](https://models.dev). Asegura que pi siempre pueda arrancar, incluso si la red falla. |
| **2. Fetch en vivo de `/models`** | NaN Runtime API | Obtiene los modelos disponibles en tiempo real según el tier de tu API key. Se combina con los datos del fallback. |

> [!IMPORTANT]
> **Detección de Tier**: La lista en vivo es la autoridad. Si tu clave tiene acceso premium, esos modelos aparecerán automáticamente; de lo contrario, se filtran.

Los ids no-chat que devuelve `/models` en vivo (embedding, rerank, TTS, STT, imagen) **no se registran** como modelos de chat — la clasificación es el único `NON_CHAT_MODEL_IDS` exportado desde `src/fetch-models.ts` (la misma fuente que usa el generador en build-time). La fusión salta sus marcadores y los coloca en un bucket observable `nonChat`; `baselineModels` también los filtra como capa defensiva. Esto evita que el selector de chat de pi ofrezca endpoints que no pueden servir chat (las peticiones devolverían 404).

El registro es síncrono a propósito: el catálogo de fallback está disponible al instante, y el runtime de Models de pi dirige el refresco en vivo (refresco de red en el arranque interactivo y periódico, solo caché en el registro), persistiendo el overlay entre ejecuciones.

### 🧠 Seguridad al cambiar de modelo (guard de razonamiento cross-model)

Al cambiar de modelo, pi-ai reenvía el razonamiento del modelo anterior como texto plano de asistente — **sin límite de tamaño**. Un único razonamiento largo o degenerado puede desbordar la ventana de un modelo de 262K, y NaN responde con un `400 Invalid request. Check your request parameters.` genérico que parece un bug del proveedor (seguimiento upstream: [pi-nan-provider#3](https://github.com/gtrabanco/pi-nan-provider/issues/3); issue abierta upstream: [pi#6167](https://github.com/earendil-works/pi/issues/6167)).

Este paquete **elimina todos los bloques de razonamiento cross-model reenviados**, de modo que cambiar de un modelo de 1M de contexto a uno de 262K (`qwen3.6`) ya no desborda la ventana. Las respuestas y los tool results de los modelos no se tocan — solo se quitan sus trazas internas de razonamiento, así que `qwen3.6` puede seguir respondiendo sobre lo que hizo otro modelo. El razonamiento del mismo modelo no se toca nunca, y el guard solo actúa sobre peticiones dirigidas a los proveedores de este paquete. Pon `NAN_THINKING_GUARD=0` para desactivarlo.

Si una petición sigue desbordando — guard desactivado, inflado que no es un bloque de razonamiento (tool outputs grandes, imágenes) o una ventana de destino más pequeña — NaN responde con el mismo 400 genérico en lugar de nombrar el desbordamiento, y la auto-compactación de pi no lo reconoce, así que la sesión se queda atascada en el techo. Por eso el proveedor **vuelve a comprobar el tamaño de la petición a la salida**: cuando llega ese 400 genérico para una petición estimada por encima de la ventana del modelo, el error se reescribe como un mensaje de context overflow que pi reconoce, de modo que compacta y reintenta en vez de bloquearse. Un 400 genérico en una petición dentro de la ventana no se toca, así que nunca se etiquetan mal errores no relacionados.

### ⏱️ Streams truncados intermitentes (auto-retry, sin stall silencioso)

El gateway LiteLLM de NaN cierra ocasionalmente un stream SSE **antes** de emitir el chunk final `finish_reason` (observado en `glm5.3-flash`; [issue #2](https://github.com/gtrabanco/pi-nan-provider/issues/2)). El catálogo declara `supportsFinishReason: true`, así que pi-ai lo convierte en el error `Stream ended without finish_reason` — que coincide con el patrón de errores reintentables de pi y se **reintenta automáticamente**, en vez de aceptar en silencio una respuesta a medias. Si una versión del gateway nunca manda `finish_reason`, el turno ahora falla de forma visible al agotar los reintentos.

Puedes sobrescribir el `compat` de cualquier modelo en `~/.pi/agent/models.json` (docs de pi → Per-model Overrides); los overrides se componen por encima del proveedor registrado. Ejemplo (forzando el comportamiento de retry explícitamente):

```json
{
  "providers": {
    "nan": {
      "modelOverrides": {
        "glm5.3-flash": { "compat": { "supportsFinishReason": true } }
      }
    }
  }
}
```

> Poner `supportsFinishReason: false` restaura el antiguo stall silencioso — no recomendado.

**Uso de tokens en streaming:** `supportsUsageInStreaming` es `true` por defecto. El esquema publicado de NaN no documenta `stream_options`, pero el gateway real lo acepta y lo aplica — medido el 2026-09-16 ([#7](https://github.com/gtrabanco/pi-nan-provider/issues/7)): dos llamadas de streaming idénticas por modelo, 0 chunks de usage sin el flag y exactamente 1 con él, en `deepseek-v4-flash`, `glm5.3-flash`, `qwen3.6`, `mimo-v2.5` y `gemma4`. Por eso pi muestra tokens reales de entrada/salida/reasoning/caché en lugar de ceros. Si un modelo resulta no devolver el usage en streaming, desactívalo por modelo — el sanitizer entonces elimina `stream_options` y el payload vuelve a ser estricto:

```json
{
  "providers": {
    "nan": {
      "modelOverrides": {
        "some-model": { "compat": { "supportsUsageInStreaming": false } }
      }
    }
  }
}
```

## 🔑 Autenticación

`resolve()` comprueba primero la credencial almacenada y después recurre a la variable de entorno correspondiente.

| Método | Comando / Acción | Notas |
| :--- | :--- | :--- |
| **Var de Entorno** | `export NAN_API_KEY="..."` | Lo más rápido para desarrollo local. |
| **`/login`** | `pi > /login nan` | Persistente; se guarda en `~/.pi/agent/auth.json`. |
| **Config Manual** | Editar `~/.pi/agent/auth.json` | Manipulación directa de JSON. |

Consigue una clave en la [plataforma NaN](https://cloud.nan.builders/r/7GK06FX8) (ajustes de usuario → API Keys; enlace de referidos).

## 🔌 MCP nativo

Dado que [pi 0.99.0 incluye un cliente MCP integrado](https://github.com/earendil-works/pi/blob/main/docs/usage.md), este paquete migra sus puentes a MCP nativo (requiere `pi >=0.99, <2` — pi 0.99 hasta 1.0 son compatibles; el rango peer se amplió a `<2` en 0.11.0).

Ambos puentes están **activados por defecto** (por sesión, visibles en `/mcp`). Usa `/nan-mcp` para gestionarlos.

> [!TIP]
> ¿Prefieres configurar los servidores MCP de NaN tú mismo? Desde pi 0.99.2/1.0, un servidor MCP HTTP en el `mcp.json` global puede autenticarse con tu token de `/login nan` en vez de una clave copiada: `{ "auth": { "provider": "nan" } }` (solo en el `mcp.json` global; requiere `https`). El registro integrado de `nan-search` sigue usando `NAN_API_KEY`/la credencial almacenada.

### 🛠️ Comando de Gestión: `/nan-mcp`

| Comando | Efecto |
| :--- | :--- |
| `/nan-mcp status` | Muestra el estado actual de ambos puentes y la resolución de la clave API. |
| `/nan-mcp enable [target]` | Activa `web-search` o `nan-mcp-server` (persiste). |
| `/nan-mcp disable [target]` | Desactiva un puente de forma persistente. |

Ambos puentes resuelven la credencial almacenada de `/login nan` (almacenada → env). Si ninguna se resuelve, el puente no se registra y se muestra un aviso en la salida de estado.

> [!NOTE]
> El registro ocurre cuando se carga la extensión. Si ejecutas `/login nan` **después** de que la sesión haya empezado, la factoría ya se ejecutó — usa `/reload` (o `/nan-mcp enable`) para registrar los puentes sin reiniciar pi.

### 🚧 Hosts sin la extensión MCP integrada de pi (PI WEB)

pi conecta los servidores registrados desde la extensión que maneja `mcp_servers_change` — la
extensión integrada `mcp`, que además registra `/mcp`. Los hosts que construyen el resource loader
de pi sin `extensionFactories` no cargan **ninguna** extensión integrada (verificado:
`createAgentSessionServices` de PI WEB, pi 0.99.1 / pi-web 1.202609.1), así que nada conecta los
servidores y pi reporta `MCP server "nan-media" is registered, but no loaded extension connects MCP
servers`.

Ahí los puentes no pueden exponer herramientas, así que este paquete reemplaza ese error críptico
con un único aviso por sesión, mantiene los registros inactivos y deja que `/nan-mcp enable` persista
el toggle sin registrar un servidor que nunca podrá conectarse. Para tener MCP en la CLI, activa el
conector con `pi config` → Built-in extensions → `mcp`.

### Funciones de pi 0.99-1.0 y modelos NaN

- **Modelos virtuales** — registra un router bajo `nan` (`pi.registerVirtualModel({ provider: "nan", ... })`);
  enruta a los modelos físicos de NaN sin configuración por parte del proveedor. El guard de
  razonamiento entre modelos se salta las selecciones virtuales, porque el modelo físico enrutado no
  es visible para el hook `context`.
- **Codemode** — funciona con cualquier modelo NaN que soporte tool calling. Las herramientas MCP de
  este paquete usan `exposure: "direct"`, así que los scripts de codemode también pueden llamarlas.
  Requiere la extensión integrada `codemode` de pi (ver la nota de PI WEB arriba).
- **Modelos clasificadores** — no aplica: NaN no expone ninguna API de clasificación (solo chat y
  endpoints de embedding/rerank/audio/imagen), así que este proveedor no registra modelos
  `type: "classifier"`.

- **Modelos de imagen nativos de NaN** — flux-2-klein (text-to-image + image-to-image) y
  qwen-image-2.1 (text-to-image) se registran como modelos de imagen de pi (`type: "image"`,
  api `"nan-images"`). No aparecen en `/model`; se acceden desde codemode
  con `models.generateImages(model, { input })` o desde extensiones con
  `ctx.modelRegistry.generateImages()`:

  ```
  const painter = await models.getModelOfType("image", "nan", "flux-2-klein")
  const result = await models.generateImages(painter, { input: [{ type: "text", text: "A red fox in the snow, watercolor" }] })
  if (result.stopReason !== "stop") return result.errorMessage
  for (const block of result.output) if (block.type === "image") image(block)
  ```

  Ambos modelos necesitan el tier de membresía "inference" (403 de lo contrario); los endpoints
  de imagen tienen su propio límite de tasa separado del chat (20 peticiones/min, 100
  peticiones/mes compartido entre los dos modelos) y no consumen el presupuesto de tokens del
  chat. [docs de NaN](https://nan.builders/docs/models) y [OpenAPI](https://nan.builders/openapi.json)
  (comprobado 2026-10-01). El servidor MCP nan-media de la comunidad ya ofrece la misma
  generación y edición como herramientas MCP, mientras que los modelos de imagen nativos permiten
  que codemode y las extensiones los llamen directamente.

---

### 1. Servidor MCP oficial de NaN
*Puente oficial para herramientas remotas vía [https://api.nan.builders/mcp](https://nan.builders/docs/api).*

- **`mcp__nan_search__web_search(query, ...)`**: Realiza búsquedas web a través del gateway de NaN.
  > pi 0.99.0–0.99.1 usaba la forma con guiones (`mcp__nan-search__web_search`); pi 0.99.2+ sanitiza
  > los nombres de herramientas a solo `[A-Za-z0-9_]`, así que los guiones se convirtieron en
  > guiones bajos. La forma con guiones bajos aplica desde 0.99.2 hasta pi 1.0.

### 2. Servidor MCP de Media (Comunidad)
*Conecta [`nan-mcp-server`](https://github.com/luciferfran/nan-mcp-server) mediante un cliente stdio local mínimo.*

- **Por sesión**: El servidor se conecta al registrarse (eager). Aparece en `/mcp` con fuente "extension".
- **Configuración**: Los archivos se guardan en `~/nan-mcp-output/`.

| Herramienta | Propósito |
| :--- | :--- |
| `mcp__nan_media__generate_image` | Generación de imágenes (flux-2-klein) |
| `mcp__nan_media__edit_image` | Edición imagen→imagen (flux-2-klein) |
| `mcp__nan_media__text_to_speech` | Síntesis de audio (kokoro) |
| `mcp__nan_media__list_voices` | Listar voces disponibles |
| `mcp__nan_media__speech_to_text` | Transcripción de audio (whisper) |
| `mcp__nan_media__list_models` | Listar los ids de modelos que alcanza la key |
| `mcp__nan_media__embed_text` | Embeddings de texto (qwen3-embedding) |
| `mcp__nan_media__rerank_documents` | Reordenación de documentos (Qwen3-Reranker) |

> pi 0.99.0–0.99.1 usaba las formas con guiones (`mcp__nan-search__web_search`,
> `mcp__nan-media__*`); pi 0.99.2+ sanitiza los nombres de herramientas a solo
> `[A-Za-z0-9_]`, así que los guiones se convirtieron en guiones bajos. La forma
> con guiones bajos aplica desde 0.99.2 hasta pi 1.0.

#### 🔧 Configuración del Puente de Media

| Variable | Por defecto | Descripción |
| :--- | :--- | :--- |
| `NAN_MEDIA_MCP` | — | Override por sesión (`0` o `false` para desactivar). |
| `NAN_MEDIA_MCP_VERSION` | `1.1.2` | Versión del servidor fijada (recomendado). |
| `NAN_MEDIA_MCP_COMMAND` | — | Override del comando personalizado. |
| `NAN_MEDIA_MCP_TIMEOUT_MS` | `120000` | Timeout por llamada. |
| `NAN_MCP_TOOLS` | — | Override para el puente oficial (`0` para desactivar). |

#### 🤖 Detección Automática de Actualizaciones

Una nueva versión de `nan-mcp-server` no desviará silenciosamente el pin de esta conexión. El planificador (`.github/workflows/check-nan-mcp-server-update.yml`) se ejecuta semanalmente y, cuando encuentra una versión nueva, abre un issue indicando si el cambio es **breaking** o **seguro**.

```bash
bun run check-nan-mcp-server            # reporte legible
bun run check-nan-mcp-server --json     # JSON para máquinas
bun run check-nan-mcp-server --issue    # crea/refresca el issue
```

---

## 📊 Uso de Cuotas: `/nan-usage`

Muestra tu uso de tokens de NaN por modelo combinado con los límites mensuales documentados, los totales de la ventana, tus totales acumulados y el tiempo hasta el reinicio del ciclo de facturación.

### Cómo funciona

`/nan-usage` llama al endpoint [`GET /v1/usage`](https://nan.builders/docs/api#tag/usage) de NaN con **la misma API key que ya usas para chat** — la credencial guardada en pi (`/login nan`) o `NAN_API_KEY`. Sin login de la CLI, sin cookie de sesión, sin configuración extra.

El endpoint devuelve tu uso (filas por fecha y modelo) y los totales de la ventana solicitada — máximo 90 días inclusivos. El comando lee esos totales y los combina con los límites publicados en la [documentación de NaN](https://nan.builders/docs/models) para mostrarte qué porcentaje de cada cuota mensual has consumido. `/usage` solo reporta consumo, así que los límites siempre vienen de la tabla documentada (comprobado 2026-09-27).

Límite de tasa: 30 peticiones por minuto para `/usage`, separado del de los endpoints de modelos.

### Uso

```
/nan-usage        # mes en curso en UTC (coincide con las cuotas mensuales)
/nan-usage 7      # ventana móvil de 7 días (1-90)
/nan-usage 30     # ventana móvil de 30 días
/nan-usage help   # muestra la línea de uso
```

### Configuración

1. **Autentica el proveedor `nan` en pi** con tu clave `sk-...`:
   ```
   /login nan
   ```
   o expórtala en su lugar:
   ```bash
   export NAN_API_KEY=sk-...
   ```
2. **Úsalo en pi**:
   ```
   /nan-usage
   ```

> [!TIP]
> ¿No se resuelve ninguna API key? El comando muestra la tabla estática de cuotas de la documentación y te indica cómo autenticarte.

### Lo que ves

**Con API key** (uso real):
```
📊 NaN Usage

🗓️  Window: 2026-09-01 → 2026-09-27 UTC (27 days)

⏱️  Next billing reset: 2026-09-30 UTC (2d 14h 30m 0s)

Models with monthly caps:

DeepSeek V4 Flash:
  [████████░░░░░░░░░░░░] 40.0% of monthly cap
  Used: 1.2B / 3.0B (1.8B remaining) · 5,120 requests

MiMo V2.5:
  [███░░░░░░░░░░░░░░░░░] 12.5% of monthly cap
  Used: 125.0M / 1.0B (875.0M remaining) · 840 requests

GLM 5.3 👑:
  [████████░░░░░░░░░░░░] 40.0% of monthly cap
  Used: 1.2B / 3.0B (1.8B remaining) · 2,400 requests
  ↳ rolling window: 400.0M / 4h (daily granularity — /usage cannot break it down)

Uncapped models:

Qwen 3.6: 890.5K used · 123 requests

Window totals: 2.6B tokens (2.0B prompt / 640.0M completion) · 18,432 requests
All time: 13.2B tokens · 41,250 requests (cached 2026-02-01)
💡 Source: GET /v1/usage · caps from https://nan.builders/docs/models
```

**Sin API key** (solo límites estáticos):
```
📊 NaN Quota Status (static limits)

⏱️  Next billing reset: 2026-09-30 UTC (2d 14h 30m 0s)

Model                        Monthly Cap
─────────────────────────────────────────────────
DeepSeek V4 Flash            3.0B
MiMo V2.5                    1.0B
MiMo V2.6 Flash              1.0B
Qwen 3.6                     uncapped
Gemma 4                      uncapped
Qwen 3.8 Flash               500.0M
GLM 5.3 Flash                2.0B
GLM 5.3                      3.0B 👑 (rolling 400.0M/4h)

💡 Set NAN_API_KEY or run `/login nan` to see real usage (GET /v1/usage).
```

Los errores siguen siendo accionables: `401` → ejecuta `/login nan` o corrige `NAN_API_KEY`, `404` → la cuenta no tiene identidad de uso que reportar, `429` → reintenta tras los segundos de `Retry-After`.

---

## 📊 Modelos

Catálogo base (verificado contra [docs de NaN](https://nan.builders/docs/models) y [OpenAPI](https://nan.builders/openapi.json)).

Modelos de chat:

| Modelo | Contexto | Máx. Salida | Entrada | Razonamiento |
| :--- | :--- | :--- | :--- | :---: |
| `qwen3.6` | 262,144 | 65,536 | texto, imagen | ✅ |
| `gemma4` | 262,144 | 32,768 | texto, imagen | ✅ |
| `deepseek-v4-flash` | 1,000,000 | 384,000 | texto, imagen | ✅ |
| `mimo-v2.6-flash` | 1,048,576 | 131,072 | texto, imagen | ✅ |
| `glm5.3-flash` | 1,000,000 | 131,072 | texto, imagen | ✅ |
| `qwen3.8-flash` | 262,144 | 131,072 | texto, imagen | ✅ |

Modelos de imagen no-chat (disponibles vía `models.generateImages()` /
`getModelOfType("image", …)`, no a través de `/model`):

| Modelo | Entrada | Propósito |
| :--- | :--- | :--- |
| `flux-2-klein` | texto, imagen | Text-to-image + image-to-image |
| `qwen-image-2.1` | texto | Text-to-image |

> [!NOTE]  
> `mimo-v2.6-flash` está servido por NaN y desde el 2026-09-29 aparece también en models.dev (proveedor `nan`); la entrada manual que lo sostenía se conserva como fallback y su nota de procedencia sigue unida a la entrada generada.
>
> `mimo-v2.5` fue eliminado por NaN: ya no aparece ni en [los docs de NaN](https://nan.builders/docs/models) ni en la [lista de modelos del OpenAPI](https://nan.builders/openapi.json) (comprobado 2026-09-29), así que sale del catálogo — lo sustituye `mimo-v2.6-flash` (mismos límites 1,048,576 / 131,072 y cuota mensual de 1.0B). El consumo histórico de `mimo-v2.5` en `/nan-usage` sigue apareciendo en la sección de modelos no documentados.

---

---

## 🧠 Controles de razonamiento

El parámetro `reasoning_effort` de NaN controla cuánto piensa el modelo antes de responder — pero el grado de control varía por modelo:

| Modelo | Effort de razonamiento | Cómo funciona |
| :--- | :--- | :--- |
| `glm5.3`, `glm5.3-flash` | `minimal` · `low` · `medium` · `high` · `max` | Completamente controlable — valores más altos permiten al modelo razonar más; `minimal` produce ~38 tokens de razonamiento (issue #16, medido 2026-09-27); `none` NO suprime el razonamiento en glm5.3-flash (13,382 tokens) |
| `qwen3.6`, `gemma4` | `none` · `minimal` · `low` · `medium` · `high` · `max` | `none`/`minimal` omiten el razonamiento por completo; otros valores limitan a 2K / 8K / 16K / 32K tokens. `thinking: "off"` envía `reasoning_effort: "none"` automáticamente vía el `thinkingLevelMap` del catálogo — los docs de NaN dicen que sin parámetro estos modelos razonan por defecto (presupuesto de 16,384 tokens), así que `off` debe ser explícito |
| `deepseek-v4-flash` | `none` · `minimal` · `low` · `medium` · `high` · `max` (el catálogo declara ["none"]) | `none` deshabilita el razonamiento de forma fiable (0 tokens de razonamiento, medido 2026-09-27); cualquier otro valor deja 13-14K tokens de razonamiento y causa razonamiento descontrolado (finish_reason:"length" con CERO texto de respuesta) — el catálogo solo declara `none` porque el resto es ruido. `thinking: "off"` ahora envía `reasoning_effort: "none"` automáticamente vía el `thinkingLevelMap` del catálogo |
| `qwen3.8-flash`, `mimo-v2.6-flash` | *(aceptado pero no ajustable)* | El parámetro es aceptado y nunca rechazado, pero el modelo gestiona su propia profundidad de razonamiento — nunca es un error enviar un valor que estos modelos no ajustan |

> [!NOTE]  
> `maxTokens` NO limita la fase de razonamiento en los modelos de NaN. La fase de razonamiento corre hasta completarse (o se trunca a ~60,000 caracteres para deepseek-v4-flash) independientemente de `maxTokens` — medido: `max_tokens=512` en deepseek-v4-flash aún consumió 13,376 tokens de completación, todos de razonamiento (26x el techo). Este es un comportamiento del gateway confirmado por el issue #16 (medido 2026-09-27).

## 🚀 Desarrollo

```bash
bun install
bun run generate-models   # Regenerar catálogo de fallback
bun test                  # Ejecutar todos los tests
bun run typecheck         # Ejecutar typechecking
```

*Las versiones siguen semver estricto. CI publica automáticamente al hacer merge a `main`.*