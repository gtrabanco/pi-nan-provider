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
4. **Si es modo `schedule`**: crea/actualiza un issue con label `sdk-monitor`
5. **Si es modo `workflow_dispatch`**: ejecuta con `--fail` para CI

## Paquetes monitorizados

- `@earendil-works/pi-ai` → peerDep: `>=0.83.0 <1`
- `@earendil-works/pi-coding-agent` → peerDep: `>=0.83.0 <1`

## Niveles de alerta

| Nivel | Significado | Acción |
|-------|-------------|--------|
| 🟢 up-to-date | Ya en la última versión | Ninguna |
| 🟡 minor | Actualización menor disponible | Revisar changelog, actualizar si es seguro |
| 🔴 BREAKING | Actualización mayor disponible | Revisar changelog cuidadosamente, posible breaking change |
| ❗ WARNING | Versión actual no satisface peerDep | **URGENTE**: actualizar devDependencies |

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
