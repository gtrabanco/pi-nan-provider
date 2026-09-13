# @gtrabanco/pi-nan-provider

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-0.6.5-blue)](https://github.com/gtrabanco/pi-nan-provider/releases)

[NaN Builders](https://nan.builders) model provider + MCP bridges para [pi](https://github.com/earendil-works/pi). 

Registra el proveedor `nan` vía `pi.registerProvider()` usando la API OpenAI-compatible de NaN (`https://api.nan.builders/v1`), y conecta las herramientas MCP de NaN en pi con `pi.registerTool()`.

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

**Uso de tokens en streaming:** `supportsUsageInStreaming` es `false` por defecto porque el esquema publicado de NaN no documenta `stream_options`; sin él, el usage aparece a cero. Si has confirmado que tu modelo devuelve el chunk de usage en streaming, activalo por modelo — el sanitizer de peticiones entonces reenvía `stream_options: { "include_usage": true }` y pi muestra los tokens reales en lugar de ceros:

```json
{
  "providers": {
    "nan": {
      "modelOverrides": {
        "qwen3.6": { "compat": { "supportsUsageInStreaming": true } }
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

## 🔌 Puentes MCP

Dado que [pi no incluye un cliente MCP integrado](https://github.com/earendil-works/pi/blob/main/docs/usage.md), este paquete conecta los servidores MCP como **herramientas nativas de pi**.

Ambos puentes están **activados y son perezosos (lazy) por defecto**. Usa `/nan-mcp` para gestionarlos.

### 🛠️ Comando de Gestión: `/nan-mcp`

| Comando | Efecto |
| :--- | :--- |
| `/nan-mcp status` | Muestra el estado actual de ambos puentes. |
| `/nan-mcp enable [target]` | Activa `web-search` o `nan-mcp-server` (persiste). |
| `/nan-mcp disable [target]` | Desactiva un puente de forma persistente. |

---

### 1. Servidor MCP oficial de NaN
*Puente oficial para herramientas remotas vía [https://api.nan.builders/mcp](https://nan.builders/docs/api).*

- **`nan_web_search(query, ...)`**: Realiza búsquedas web a través del gateway de NaN.

### 2. Servidor MCP de Media (Comunidad)
*Conecta [`nan-mcp-server`](https://github.com/luciferfran/nan-mcp-server) mediante un cliente stdio local mínimo.*

- **Carga Perezosa (Lazy)**: El proceso del servidor se lanza **solo** cuando se invoca una herramienta y se cierra inmediatamente después.
- **Configuración**: Los archivos se guardan en `~/nan-mcp-output/`.

| Herramienta | Propósito |
| :--- | :--- |
| `nan_generate_image` | Generación de imágenes (flux-2-klein) |
| `nan_edit_image` | Edición imagen→imagen (flux-2-klein) |
| `nan_text_to_speech` | Síntesis de audio (kokoro) |
| `nan_list_voices` | Listar voces disponibles |
| `nan_speech_to_text` | Transcripción de audio (whisper) |

#### 🔧 Configuración del Puente de Media

| Variable | Por defecto | Descripción |
| :--- | :--- | :--- |
| `NAN_MEDIA_MCP` | — | Override por sesión (`0` o `false` para desactivar). |
| `NAN_MEDIA_MCP_VERSION` | `1.0.8` | Versión del servidor fijada (recomendado). |
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

## 📊 Modelos

Catálogo base (verificado contra [docs de NaN](https://nan.builders/docs/models) y [OpenAPI](https://nan.builders/openapi.json)).

| Modelo | Contexto | Máx. Salida | Entrada | Razonamiento |
| :--- | :--- | :--- | :--- | :---: |
| `qwen3.6` | 262,144 | 65,536 | texto, imagen | ✅ |
| `gemma4` | 262,144 | 32,768 | texto, imagen | ✅ |
| `deepseek-v4-flash` | 1,000,000 | 384,000 | texto, imagen | ✅ |
| `mimo-v2.5` | 1,048,576 | 131,072 | texto, imagen | ✅ |
| `glm5.3-flash` | 1,000,000 | 131,072 | texto, imagen | ✅ |
| `qwen3.8-flash` | 262,144 | 131,072 | texto, imagen | ✅ |

---

## 🚀 Desarrollo

```bash
bun install
bun run generate-models   # Regenerar catálogo de fallback
bun test                  # Ejecutar todos los tests
bun run typecheck         # Ejecutar typechecking
```

*Las versiones siguen semver estricto. CI publica automáticamente al hacer merge a `main`.*