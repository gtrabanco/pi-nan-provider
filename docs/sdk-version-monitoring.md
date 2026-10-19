# PI SDK Version Monitoring

Este repositorio incluye un sistema de monitorización de versiones del SDK de Pi que detecta automáticamente actualizaciones de `@earendil-works/pi-ai` y `@earendil-works/pi-coding-agent`.

## ¿Por qué?

El SDK de Pi ha tenido incidentes de packaging (ej. `0.85.0` con barrel roto) que rompían `npm install` / `bun install` para todos los repositorios dependientes. Este sistema:

1. Detecta nuevas versiones disponibles en npm
2. Verifica que la versión más reciente sea compatible con los `peerDependencies`
3. Genera issues automáticos cuando hay actualizaciones que requieren revisión

## Uso

### Reporte interactivo
```bash
bun run check-pi-sdk-versions
# o
node scripts/check-pi-sdk-versions.mjs --report
```

### Modo CI (JSON)
```bash
node scripts/check-pi-sdk-versions.mjs
```

### Modo fail (CI)
```bash
node scripts/check-pi-sdk-versions.mjs --fail
```

## Workflow GitHub Actions

El workflow `.github/workflows/check-pi-sdk-versions.yml` se ejecuta:

- **Automáticamente**: cada lunes a las 09:00 UTC
- **Manual**: desde la pestaña Actions de GitHub

### Comportamiento

1. Ejecuta el script de monitorización
2. Compara las versiones de devDependencies con las últimas en npm
3. Verifica compatibilidad con peerDependencies
4. Si hay actualización minor/major (o WARNING de peer range):
   - crea/actualiza un issue con label `sdk-monitor` que lista los bumps concretos,
   - prepara y abre un PR con el bump de devDependencies (ver "PR automático" abajo).
5. Si todo está al día: no hace nada.

## Paquetes monitorizados

- `@earendil-works/pi-ai` → peerDep: `>=0.99.0 <2`
- `@earendil-works/pi-coding-agent` → peerDep: `>=0.99.0 <2`

## Niveles de alerta

| Nivel | Significado | Acción |
|-------|-------------|--------|
| 🟢 up-to-date | Ya en la última versión | Ninguna |
| 🟡 minor | Actualización menor disponible | Revisar el PR automático (ver abajo) |
| 🔴 BREAKING | Actualización mayor disponible | Revisar changelog cuidadosamente, posible breaking change |
| ❗ WARNING | Versión actual no satisface peerDep | **URGENTE**: actualizar devDependencies |

## PR automático de actualización

Desde el realineamiento con pi 1.3.0 (issue #25), el workflow no solo abre el issue:
cuando detecta una actualización minor/major (o un WARNING de peer range), el job
`prepare-pr` prepara un PR automáticamente:

1. `scripts/prepare-sdk-update-pr.mjs` sube las versiones en `devDependencies` de
   `package.json` (reemplazo exacto de strings; el resto del fichero no se toca) y
   escribe el cuerpo del PR.
2. El workflow ejecuta `bun install && bun test && bun run typecheck` sobre el bump.
3. Genera un **diff de superficie de tipos** (`dist/index.d.ts`, `dist/compat.d.ts`,
   `dist/api/openai-completions.d.ts`) entre la versión anterior y la nueva, descargando
   ambos tarballs de npm, y lo incrusta en el PR.
4. Crea la rama `chore/pi-sdk-<version>` y abre el PR con `gh pr create`.

El proceso es idempotente: si la rama ya existe en `origin` o ya hay un PR abierto para
ella, el job se salta el resto de pasos. El cuerpo del PR incluye un checklist de
revisión: un bump minor de pi puede cambiar comportamiento relevante para el proveedor
(ver `AGENTS.md`, "Verified API facts"), así que la revisión humana del changelog
upstream sigue siendo obligatoria antes del merge.

## Troubleshooting

### Falso positivo por `check-pi-sdk-versions`
Verifica que las versiones en `devDependencies` coincidan con las esperadas:
```bash
bun list --depth=0 | grep pi-
```

### npm registry timeout
El script tiene timeout de 15s por paquete. Si falla, reintenta:
```bash
node scripts/check-pi-sdk-versions.mjs --report
```

### Actualizar manualmente
```bash
# Actualizar a la última versión que satisfaga peerDep
bun remove @earendil-works/pi-ai @earendil-works/pi-coding-agent
bun add @earendil-works/pi-ai@latest @earendil-works/pi-coding-agent@latest
bun test
```
