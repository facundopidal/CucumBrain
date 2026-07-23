---
name: pepidocs-knowledge
description: "Trigger: finalizar tarea, registrar decisión, actualizar bitácora, documentar por qué. Captura y documenta el conocimiento del proyecto en la bitácora y archivos de conocimiento."
license: Apache-2.0
metadata:
  author: "gentleman-programming"
  version: "1.0"
---

## Activation Contract

Activa esta skill cuando:
- Finalices una tarea corta (flujo Fast-Track) o una tarea larga (SDD).
- Realices cambios en el código que requieran un commit o push.
- Modifiques reglas de negocio, lógica del dominio o patrones del código.
- Debas documentar decisiones del usuario y los motivos detrás de ellas.

## Hard Rules

- **Prohibido adivinar:** No asumas el porqué de una decisión del usuario. Si no está en el chat, debes preguntar usando una pregunta de aclaración.
- **Sin código en reglas de negocio:** La documentación en `docs/KNOWLEDGE.md`, módulos y flujos no debe contener nombres de variables, funciones, clases o identificadores técnicos. Debe ser lenguaje natural legible para perfiles de negocio.
- **Triaje de Flujo Obligatorio:** Al inicio de cada tarea, debes evaluar y proponer explícitamente el flujo adecuado (Fast-Track vs SDD) según tamaño, complejidad y riesgo.
- **Bitácora Obligatoria:** Cada cambio en el código debe dejar una entrada en la bitácora (`docs/bitacora.md`).
- **Conectores Clickables:** Todos los enlaces a archivos modificados o plantillas deben usar enlaces markdown válidos en formato `file:///` con rutas absolutas o relativas correctas.

## Decision Gates

| Complejidad del Cambio | Documentación Requerida |
| :--- | :--- |
| Cambio Corto (<150 líneas, baja complejidad) | Entrada directa en `docs/bitacora.md`. |
| Cambio de Negocio o Flujo | Entrada en `docs/bitacora.md` + actualizar glosario en `docs/KNOWLEDGE.md` o crear flujo en `docs/flows/`. |
| Cambio Arquitectónico Largo | Entrada en `docs/bitacora.md` + crear un ADR en `docs/adr/`. |
| Nuevo Patrón de Código | Documentar en `docs/conventions/`. |

## Execution Steps

1. **Revisión de Cambios:** Ejecuta `git diff` o revisa los archivos modificados para tener claro qué se implementó.
2. **Entrevista Challenger (Desafío):** Identifica las decisiones técnicas o de negocio tomadas. Pregunta al usuario el *"por qué"* de las decisiones si no han quedado claras en la conversación. Ofrece alternativas y tradeoffs si detectas decisiones arbitrarias.
3. **Redacción del Borrador:** Genera las propuestas de actualización en formato markdown:
   - **Bitácora:** Entrada fechada con: *Qué se hizo*, *Decisión clave y Autoría (Usuario / Agente / Consenso)*, *Por qué (justificación)* y *Archivos*.
   - **ADR / Reglas / Glosario:** Si corresponde, redacta el archivo correspondiente usando la plantilla adecuada.
4. **Validación de Reglas de Negocio:** Asegúrate de que las reglas de negocio no incluyan términos de código.
5. **Presentación e Implementación:** Muestra el borrador al usuario para aprobación. Una vez aprobado, escribe los cambios en los archivos correspondientes en la carpeta `docs/`.

## Output Contract

El agente retornará:
- Los archivos creados o actualizados bajo la carpeta `docs/`.
- Un resumen del porqué de las decisiones documentadas.
- Los enlaces clickables a los archivos modificados.

## References

- [docs/KNOWLEDGE.md](file:///C:/Users/Win10/Desktop/Programacion/Dev/pepidocs/templates/pepidocs/docs/KNOWLEDGE.md) — Glosario y reglas del negocio globales.
- [docs/bitacora.md](file:///C:/Users/Win10/Desktop/Programacion/Dev/pepidocs/templates/pepidocs/docs/bitacora.md) — Diario cronológico de cambios del proyecto.
