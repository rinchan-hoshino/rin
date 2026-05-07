[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [More languages](README.md)

# Rin

> **Tu asistente personal de IA, viviendo en tu computadora.**<br>
> Rin recuerda lo importante, ayuda con tareas reales y mejora con el uso diario.

No es solo otra ventana de chat. Rin es un asistente que puedes mantener cerca: local, inspeccionable, conectado a tus herramientas cuando lo permites y capaz de llevar memoria útil entre sesiones.

> [!NOTE]
> Rin también se construye con Rin. El proyecto usa su propio asistente para planificar, editar, revisar, traducir y mantener este repositorio, así que la mejora propia se prueba dentro del producto.

## ✨ Por qué probar Rin

| Quieres...                            | Rin está diseñado para...                                       |
| ------------------------------------- | --------------------------------------------------------------- |
| repetir menos explicaciones           | recordar hechos, preferencias, proyectos e instrucciones        |
| un asistente que mejore con el tiempo | convertir correcciones y flujos exitosos en memoria y skills    |
| algo útil sin construirlo tú          | traer memoria, programación, herramientas, chat bridges y UI    |
| controlar lo que toca                 | ejecutarse localmente y mostrar herramientas, archivos y config |
| un asistente en muchos lugares        | conectar terminal, app de escritorio, automatización y chats    |

## 🧰 En qué puede ayudar Rin

Rin es un asistente de propósito general. Según tu configuración, puede:

- resumir, reescribir y organizar documentos
- buscar información actual en la web
- inspeccionar y gestionar archivos
- crear recordatorios y tareas programadas
- guardar notas a largo plazo a partir de trabajo repetido
- ayudar con código y repositorios
- operar comandos locales o servicios conectados bajo tu supervisión
- responder desde la terminal, la aplicación de escritorio, automatizaciones o chats conectados como el mismo asistente

## 🌱 Qué hace diferente a Rin

### Memoria global

Las sesiones de chat normales olvidan demasiado. Rin puede guardar hechos duraderos y lecciones reutilizables fuera de una sola conversación, y traerlos de vuelta cuando importan.

### Aprende de ti automáticamente

No deberías tener que convertirte en especialista en prompts para enseñar a tu asistente. Rin puede convertir correcciones repetidas y flujos de trabajo exitosos en instrucciones y habilidades compactas.

### Siempre activo en segundo plano

Rin está diseñado como un asistente que mantienes contigo, no como una pestaña desechable. Un proceso en segundo plano permite que distintas interfaces se conecten al mismo estado del asistente.

### Rin ayuda a construir Rin

Rin se mantiene con Rin. Este repositorio es una demostración viva de que el asistente puede ayudar a mejorar al propio asistente.

## ⚠️ Estado actual

> [!WARNING]
> Rin todavía es joven. Trata el uso diario como experimental: puedes encontrar bordes ásperos, documentación incompleta, comportamiento inestable o cambios incompatibles ocasionales.

Rin también puede usar más tokens de modelo, cuota de API o capacidad de suscripción que un chat puntual, porque puede conservar contexto, escribir memoria, ejecutar trabajo programado, buscar en la web y llamar modelos repetidamente.

Supervisa las acciones importantes. No dejes que Rin realice acciones irreversibles o sensibles salvo que entiendas el riesgo y puedas revisar o revertir el resultado.

## 🚀 Instalación

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

### Checkout existente

```bash
./install.sh              # stable release (default)
./install.sh --beta       # current weekly beta candidate
./install.sh --nightly    # current nightly build
./install.sh --git        # main
./install.sh --git main
./install.sh --git deadbeef
```

```powershell
.\install.ps1
.\install.ps1 --beta
.\install.ps1 --nightly
.\install.ps1 --git
.\install.ps1 --git main
.\install.ps1 --git deadbeef
```

## ⌨️ Comandos básicos

```bash
rin            # abrir Rin
rin doctor     # inspeccionar salud y configuración
rin status     # mostrar actividad de workers y tareas programadas
rin start      # iniciar el runtime en segundo plano
rin stop       # detener el runtime en segundo plano
rin restart    # reiniciar el runtime en segundo plano
rin update     # actualizar el runtime Rin instalado
rin -p "..."   # ejecutar un turno no interactivo del asistente
```

<details>
<summary>🧭 Para lectores técnicos</summary>

Rin está construido sobre Pi y conserva su espíritu KISS:

- mantener el núcleo pequeño y comprensible
- mostrar al modelo las herramientas y el contexto reales
- dejar que el modelo decida cuando esa sea la solución simple y fiable
- evitar trucos específicos de un modelo y prompts demasiado ajustados
- preferir estado local transparente frente al bloqueo de plataformas remotas

Rin no intenta ser un framework pesado de agentes. Intenta ser un asistente práctico de uso diario que pueda recordar, actuar y mejorar sin dejar de ser inspeccionable.

</details>

## 🔄 Actualización

Para actualizar una instalación normal de Rin, usa:

```bash
rin update              # stable release (default)
rin update --beta       # current weekly beta candidate
rin update --nightly    # current nightly build
rin update --git        # main
rin update --git main
rin update --git deadbeef
```

Stable es el valor por defecto para instalar y actualizar. `--beta` selecciona el candidato beta semanal actual, `--nightly` selecciona la compilación nightly actual desde `main`, y `--git` sin sufijo selecciona `main`.

Evita tratar flujos locales del repositorio como `git pull`, recompilaciones improvisadas o volver a ejecutar `install.sh` como la forma predeterminada de actualizar un Rin ya instalado.

## 📚 Documentación

Este README es la vista general pública para usuarios. Las traducciones viven en `readme/README.*.md` y deben mantenerse alineadas con esta versión en inglés.

Si vas a modificar Rin, empieza por [`docs/developer/README.md`](../docs/developer/README.md). La guía de runtime para agentes y la documentación instalada se mantienen separadas de este README público.
