[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [More languages](README.md)

# Rin

> **Tu asistente personal de IA, viviendo en tu computadora.**<br>
> Rin recuerda lo importante, ayuda con tareas reales y mejora con el uso.

Rin es un asistente local de IA de propósito general con memoria, herramientas, programación, flujos de terminal y puentes de chat integrados. Puede ayudar con documentos, investigación web, archivos, recordatorios, código, servicios conectados y flujos repetidos, mientras comparte un mismo estado de asistente entre terminal, automatización y chat.

| Lo importante                  | Qué ofrece Rin                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| Memoria global                 | Hechos, preferencias y aprendizajes útiles pueden sobrevivir a un solo chat.                |
| Aprende del uso repetido       | Correcciones y flujos exitosos pueden volverse instrucciones y skills compactos.            |
| Runtime local en segundo plano | Varias entradas se conectan al mismo asistente, no a ventanas aisladas.                     |
| Producto listo para usar       | Memoria, programación, herramientas, flujos de terminal y puentes de chat vienen incluidos. |
| Autoarranque                   | Rin se usa para construir Rin; el repositorio es una prueba viva del asistente.             |

> [!WARNING]
> Rin todavía es joven. Trata el uso diario como experimental: puedes encontrar bordes ásperos, documentación incompleta, comportamiento inestable, coste de tokens/API o cambios incompatibles ocasionales.

## Apoyar a Rin

Si Rin te ahorra tiempo, puedes apoyar su mantenimiento en [Ko-fi](https://ko-fi.com/THE_cattail). El patrocinio es voluntario y ayuda a cubrir costes continuos de mantenimiento; no compra prioridad de funciones ni compromisos de soporte privado.

## Instalación

> [!TIP]
> La mayoría de usuarios debería empezar con el comando estable de abajo. Usa estos comandos de instalación directamente; el instalador configura el comando `rin`. Los canales preliminares y git están en las secciones plegadas.

En Linux x64, las instalaciones stable, beta y nightly usan un bundle de plataforma compatible cuando está disponible. El bundle incluye el runtime de Node.js y npm administrado por Rin, por lo que esas instalaciones no requieren Node.js ni npm del sistema.

En otras plataformas, las instalaciones git o con una versión indicada directamente y cualquier instalación que recurra a la ruta de código fuente requieren Node.js 22.19.0 o una versión posterior y npm. Comprueba tus versiones locales antes de instalar:

```bash
node -v
npm -v
```

Si el instalador muestra `rin installer requires Node.js >= 22.19.0`, actualiza Node.js, abre una terminal nueva y vuelve a ejecutar el comando de instalación.

### Linux y macOS

```bash
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh
```

<details>
<summary>Otros canales de lanzamiento</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/main/install.sh | sh -s -- --beta
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh -s -- --nightly
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/main/install.sh | sh -s -- --git
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/main/install.sh | sh -s -- --git main
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/main/install.sh | sh -s -- --git deadbeef
```

</details>

### Windows

Instala desde PowerShell o Windows Terminal.

Si `node -v` es anterior a 22.19.0 en Windows, instala o actualiza Node.js primero:

```powershell
winget upgrade OpenJS.NodeJS.LTS
# Si winget indica que Node.js no está instalado:
winget install OpenJS.NodeJS.LTS
```

Después, abre una ventana nueva de PowerShell o Windows Terminal e instala Rin:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1)))
```

<details>
<summary>Otros canales de lanzamiento</summary>

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/main/install.ps1))) --beta
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1))) --nightly
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/main/install.ps1))) --git
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/main/install.ps1))) --git main
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/main/install.ps1))) --git deadbeef
```

</details>

Después de instalar, usa el mismo comando en todas las plataformas:

```bash
rin
```

El instalador de Windows escribe el lanzador del comando `rin` y, cuando puede, añade el directorio de lanzadores de usuario de Rin al `PATH` del usuario. Abre una terminal nueva si la sesión actual no encuentra `rin` de inmediato.

## Seguridad y coste

Rin puede conservar contexto, escribir memoria, ejecutar trabajo programado, buscar en la web y llamar modelos repetidamente. Esto puede consumir más tokens de modelo, cuota de API o capacidad de suscripción que un chat puntual.

Supervisa las acciones importantes. No dejes que Rin realice acciones irreversibles o sensibles salvo que entiendas el riesgo y puedas revisar o revertir el resultado.

## Dirección técnica

Rin está construido sobre Pi y conserva su espíritu KISS:

- mantener el núcleo pequeño y comprensible
- mostrar al modelo las herramientas y el contexto reales
- dejar que el modelo decida cuando esa sea la solución simple y fiable
- evitar trucos específicos de un modelo y prompts demasiado ajustados
- preferir estado local transparente frente al bloqueo de plataformas remotas

Rin no intenta ser un framework pesado de agentes. Intenta ser un asistente práctico de uso diario que pueda recordar, actuar y mejorar sin dejar de ser inspeccionable.

## Documentación

Este README es la vista general pública para usuarios. Las traducciones viven en `readme/README.*.md` y deben mantenerse alineadas con esta versión en inglés.

Si vas a modificar Rin, empieza por [`docs/developer/README.md`](../docs/developer/README.md). La guía de runtime para agentes y la documentación instalada se mantienen separadas de este README público.
