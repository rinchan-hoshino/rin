[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [More languages](README.md)

# Rin

> **Tu asistente personal de IA, viviendo en tu computadora.**<br>
> Rin recuerda lo importante, ayuda con tareas reales y mejora con el uso.

Rin es un asistente local de IA de propósito general con memoria, herramientas, programación, interfaces y puentes de chat incluidos. Rin también se construye con Rin: el proyecto usa su propio asistente para planificar, editar, revisar, traducir y mantener este repositorio.

> [!WARNING]
> Rin todavía es joven. Trata el uso diario como experimental: puedes encontrar bordes ásperos, documentación incompleta, comportamiento inestable, coste de tokens/API o cambios incompatibles ocasionales.

## Instalación

> [!TIP]
> La mayoría de usuarios debería empezar con el comando estable de abajo. Los canales preliminares y git están en las secciones plegadas.

### Linux y macOS

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh
```

<details>
<summary>Otros canales de lanzamiento</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --beta
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --nightly
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git main
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git deadbeef
```

</details>

### Windows

Instala desde PowerShell o Windows Terminal. Node.js y npm deben estar disponibles primero.

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1)))
```

<details>
<summary>Otros canales de lanzamiento</summary>

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --beta
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --nightly
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git main
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git deadbeef
```

</details>

En Windows, el instalador interactivo abre el instalador gráfico por defecto. Después de la instalación, `rin` abre la GUI de escritorio por defecto, y Rin también crea lanzadores de GUI y un lanzador de inicio por usuario para el runtime en segundo plano.

## Uso básico

```bash
rin            # abrir Rin
rin -p "..."   # ejecutar un turno único del asistente
rin doctor     # inspeccionar salud y configuración
```

## Capacidades

Rin está diseñado para trabajo cotidiano de asistente, no solo para programar:

- recordar hechos duraderos, preferencias, proyectos e instrucciones recurrentes
- resumir, reescribir y organizar documentos
- buscar información actual en la web
- inspeccionar y gestionar archivos
- crear recordatorios y tareas programadas
- guardar notas a largo plazo a partir de trabajo repetido
- ayudar con código y repositorios
- operar comandos locales o servicios conectados bajo tu supervisión
- responder desde la terminal, la aplicación de escritorio, automatizaciones o chats conectados como el mismo asistente

## Características clave

| Característica                 | Qué significa                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| Memoria global                 | Los hechos y aprendizajes útiles pueden sobrevivir más allá de un chat.             |
| Aprende del uso repetido       | Correcciones y flujos exitosos pueden volverse instrucciones y skills compactos.    |
| Runtime local en segundo plano | Varias interfaces pueden conectarse al mismo estado del asistente.                  |
| Producto listo para usar       | Memoria, programación, herramientas, puentes de chat e interfaces vienen incluidos. |
| Autoarranque                   | Rin se usa para construir Rin; el repositorio es una prueba viva del flujo.         |

## Seguridad y coste

Rin puede conservar contexto, escribir memoria, ejecutar trabajo programado, buscar en la web y llamar modelos repetidamente. Esto puede consumir más tokens de modelo, cuota de API o capacidad de suscripción que un chat puntual.

Supervisa las acciones importantes. No dejes que Rin realice acciones irreversibles o sensibles salvo que entiendas el riesgo y puedas revisar o revertir el resultado.

<details>
<summary>Dirección técnica</summary>

Rin está construido sobre Pi y conserva su espíritu KISS:

- mantener el núcleo pequeño y comprensible
- mostrar al modelo las herramientas y el contexto reales
- dejar que el modelo decida cuando esa sea la solución simple y fiable
- evitar trucos específicos de un modelo y prompts demasiado ajustados
- preferir estado local transparente frente al bloqueo de plataformas remotas

Rin no intenta ser un framework pesado de agentes. Intenta ser un asistente práctico de uso diario que pueda recordar, actuar y mejorar sin dejar de ser inspeccionable.

</details>

## Documentación

Este README es la vista general pública para usuarios. Las traducciones viven en `readme/README.*.md` y deben mantenerse alineadas con esta versión en inglés.

Si vas a modificar Rin, empieza por [`docs/developer/README.md`](../docs/developer/README.md). La guía de runtime para agentes y la documentación instalada se mantienen separadas de este README público.
