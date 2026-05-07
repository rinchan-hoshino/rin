[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [Más idiomas](README.md)

# Rin

Rin es un asistente de IA que puedes mantener en tu propio ordenador.

Si ya usas ChatGPT o una suscripción de OpenAI, Rin es el siguiente paso: un asistente que recuerda información útil entre conversaciones, aprende cómo prefieres trabajar y te ayuda con tareas reales en lugar de empezar desde cero cada vez.

Rin no es solo una idea ni una demo. Este repositorio se desarrolla con Rin: Rin se usa como asistente de larga duración para planificar, editar, revisar, traducir y mantener Rin.

## Por qué existe Rin

La mayoría de chats de IA son fáciles de empezar y fáciles de perder.

Explicas tus preferencias, proyectos, herramientas y hábitos. Luego abres un chat nuevo y vuelves a explicarlo. Rin intenta que esa relación sea menos desechable.

Rin se basa en una promesa simple:

- mantener el mismo asistente entre sesiones
- recordar hechos útiles a largo plazo de forma global
- mejorar con el uso repetido sin pedirte que mantengas prompts perfectos
- conectarse a archivos locales, información web, calendarios y superficies de chat
- seguir siendo lo bastante comprensible para que puedas inspeccionarlo y controlarlo

## Para qué puedes usar Rin

Hablas con Rin en lenguaje natural. Rin puede usar las herramientas disponibles en tu máquina y en tus cuentas configuradas.

Ejemplos:

- recordar preferencias, nombres, proyectos e instrucciones recurrentes
- resumir o reescribir documentos
- inspeccionar y organizar archivos
- buscar información actual en la web
- crear recordatorios y tareas recurrentes
- guardar notas útiles del trabajo repetido
- ayudarte a operar tu ordenador o servicios con supervisión
- responder desde terminal, GUI o chats conectados sin dejar de ser el mismo asistente

Rin pretende ser un asistente general, no solo una herramienta de programación. Programar y mantener repositorios es solo un tipo de tarea en la que puede ayudar.

## Qué hace diferente a Rin

### Listo para usar

Rin se empaqueta como un producto con un único punto de entrada: `rin`. El objetivo no es pedir a los usuarios que ensamblen por su cuenta un framework, un sistema de memoria, un planificador y un puente de chat.

### Memoria global

Rin puede conservar hechos duraderos y experiencia reutilizable fuera de una conversación individual. Las sesiones nuevas pueden empezar con más contexto importante.

### Mejora implícita

Rin puede convertir la práctica repetida en instrucciones y habilidades reutilizables. No deberías tener que convertirte en ingeniero de prompts para que tu asistente aprenda cómo trabajas.

### Un asistente local de larga duración

Rin tiene un entorno en segundo plano, así que el asistente no depende de una ventana desechable. Distintas interfaces pueden acceder al mismo estado subyacente.

### Desarrollo autoarrancado

Rin se mantiene con Rin. El proyecto es una prueba práctica de su propio diseño: el asistente que ofrece el producto también se usa para construir, revisar, traducir y mejorar el producto.

## Cómo piensa Rin sobre la tecnología

Rin hereda valores de diseño al estilo Pi:

- mantener el sistema tan simple como sea posible
- exponer herramientas y contexto con claridad
- dejar que el modelo decida cuando pueda hacerlo razonablemente
- evitar flujos de trabajo codificados solo para compensar prompts débiles
- evitar que el producto dependa de trucos ajustados a un único modelo
- preferir estado local e inspeccionable frente al bloqueo de plataformas remotas

Para lectores técnicos: Rin no intenta ser una plataforma de agentes centrada en un marketplace ni un laboratorio de autoentrenamiento centrado en investigación. Es un producto de asistente práctico que mantiene pequeño el runtime, da al modelo herramientas y memoria útiles, y se centra en la utilidad diaria a largo plazo.

## Inicio rápido

### Linux y macOS

Instala con un comando, sin clonar el repositorio:

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh
```

Otros canales de publicación:

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --beta
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --nightly
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git main
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git deadbeef
```

### Windows

Instala desde PowerShell o Windows Terminal con Node.js y npm disponibles, sin clonar el repositorio:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1)))
```

Otros canales de publicación:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --beta
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --nightly
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git main
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git deadbeef
```

En Windows, el instalador interactivo abre por defecto el instalador gráfico. Recorre idioma, usuario destino, directorio de instalación, proveedor/modelo/autenticación, revisión del plan y aplicación final. Si una escritura protegida necesita confirmación, la GUI muestra un comando de traspaso de una línea para la terminal en lugar de pedir credenciales privilegiadas dentro de la ventana.

Tras la instalación, Windows queda con una configuración orientada a GUI: el lanzamiento predeterminado `rin` abre la GUI de escritorio, y el instalador escribe lanzadores directos de GUI más un lanzador de Inicio de sesión de alcance de usuario para el runtime en segundo plano. Usa `rin gui` si quieres abrir la GUI desde una terminal, o `rin-install --tui` / `rin-install --no-gui` si necesitas el instalador de terminal.

### Desde un checkout existente

Si ya tienes el repositorio localmente, los wrappers de instalación incluidos usan el mismo flujo de selección de versión:

```bash
./install.sh              # stable release (predeterminado)
./install.sh --beta       # candidato beta semanal actual
./install.sh --nightly    # build nightly actual
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

Abre Rin:

```bash
rin
```

Comprueba la salud si hace falta:

```bash
rin doctor
rin status --watch  # actividad de workers y tareas programadas en vivo
```

## Estado actual, seguridad y costes

Rin se desarrolla activamente y todavía está en una fase temprana. Espera partes ásperas, comportamiento inestable, documentación incompleta y cambios incompatibles ocasionales.

Como Rin puede conservar contexto, escribir memoria, ejecutar trabajo programado, buscar en la web y llamar modelos repetidamente, puede consumir más tokens, cuota de API o capacidad de suscripción que un chat normal de una sola vez.

Supervisa el trabajo importante. No permitas que Rin realice acciones irreversibles, sensibles o críticas de producción salvo que entiendas el riesgo y puedas revisar o revertir el resultado.

## Escenarios de despliegue

El instalador sigue siendo local, pero estas formas de despliegue ya son viables como envoltorios de los mismos puntos de entrada de Linux/macOS/Windows. El entorno de destino debe cumplir los requisitos normales de Rin, incluidos Node.js y npm:

| Escenario                             | Viabilidad                                                    | Notas                                                                                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instalación local o para otro usuario | Soportada hoy                                                 | El instalador interactivo puede apuntar a la cuenta actual o a otro usuario local, y escribe los lanzadores y el servicio en segundo plano de ese usuario.                                                                              |
| Instalación por SSH                   | Viable hoy                                                    | Ejecuta el comando bootstrap por SSH en el host remoto. Un wrapper dedicado `rin install --ssh` podría mejorar más adelante la detección y los errores.                                                                                 |
| Instalación en contenedor             | Viable con una imagen Linux sin interfaz gráfica              | Usa un volumen persistente para el home/directorio de instalación de Rin y ejecuta el runtime en segundo plano o la CLI dentro del contenedor. Los lanzadores GUI y los servicios de usuario del host no aplican dentro del contenedor. |
| Instalación en máquina virtual        | Soportada mediante el instalador normal del sistema operativo | Instala Rin dentro del sistema invitado igual que en una máquina física. Las instantáneas de la VM facilitan la reversión, pero Rin solo gestiona el entorno invitado.                                                                  |
| Instalación en NAS                    | Viable cuando el NAS puede ejecutar Node.js o contenedores    | En NAS abiertos, prefiere la ruta Linux normal; en dispositivos NAS cerrados, prefiere el patrón de contenedor. Los gestores de paquetes del fabricante y las shells restringidas pueden requerir notas específicas del dispositivo.    |
| Instalación en la nube                | Soportada mediante SSH o bootstrap tipo cloud-init            | Trata la VM en la nube como un host Linux remoto. Conserva los datos `.rin` en un disco duradero y configura el arranque en segundo plano según el sistema operativo del host.                                                          |

Estos son escenarios de despliegue, no canales de publicación separados. Stable, beta, nightly y git siguen usando el mismo contrato de instalación/actualización anterior.

## Incluido hoy

Rin incluye una pila predeterminada enfocada:

- memoria a largo plazo
- tareas programadas y recordatorios
- búsqueda web en vivo
- herramientas de archivos y shell
- soporte de puente de chat
- rutas de acceso GUI, TUI, CLI y estilo RPC
- `rin -p` / `rin --mode json` no interactivo para turnos de asistente delegados o scriptables

## Actualizar Rin

Para una actualización normal de Rin instalado, usa:

```bash
rin update              # stable release (predeterminado)
rin update --beta       # candidato beta semanal actual
rin update --nightly    # build nightly actual
rin update --git        # main
rin update --git main
rin update --git deadbeef
```

Si confirmas que falta `rin` en la cuenta actual, trátalo como “esta no es la cuenta propietaria del lanzador”. Recupera la instalación de destino real mediante los metadatos instalados:

- `<targetHome>/.rin/installer.json`
- Linux: `~/.config/systemd/user/rin-daemon*.service`
- macOS: `~/Library/LaunchAgents/com.rin.daemon.*.plist`

Luego invoca directamente la entrada estable del runtime instalado:

```bash
node <installDir>/app/current/dist/app/rin/main.js update -u <targetUser>
```

Esta es la ruta canónica de actualización para el runtime instalado. Refresca el runtime central y la documentación instalada. No sustituye el lanzador CLI de alcance de usuario ni el instalador.

Reglas importantes de canales de publicación:

- stable es el valor predeterminado para instalar y actualizar
- `--beta` significa el candidato beta semanal actual
- `--nightly` significa el build nightly actual desde `main`
- `--git` sin sufijo significa `main`

Evita tratar flujos locales del repositorio como `git pull`, rebuilds ad hoc o volver a ejecutar `install.sh` como la forma predeterminada de actualizar un Rin ya instalado.

## Comandos principales

```bash
rin            # abrir Rin
rin doctor     # inspeccionar salud y configuración
rin status     # mostrar actividad de workers y tareas programadas
rin target     # listar y seleccionar destinos de despliegue
rin --target x # ejecutar Rin contra un entorno destino configurado
rin start      # iniciar el runtime en segundo plano
rin stop       # detener el runtime en segundo plano
rin restart    # reiniciar el runtime en segundo plano
rin update     # actualizar el runtime central instalado de Rin
```

Normalmente, usa `rin`. `rin --std` es una entrada de respaldo para recuperación en primer plano o depuración cuando la ruta RPC predeterminada no funciona.

## Documentación

Este README es la documentación de usuario. Las traducciones viven en `readme/README.*.md` y deben mantenerse alineadas con la versión inglesa; actualízalas en el mismo cambio cuando cambie contenido visible para usuarios.

La documentación interna está separada intencionalmente:

- La guía de runtime para agentes vive en `docs/agent/` y se instala en `agentDir/docs/rin/`.
- La documentación técnica para desarrolladores vive en `docs/developer/`.
- Los metadatos de notas de lanzamiento viven en `docs/release/CHANGELOG.md` para `/changelog` y flujos de release.

Si vas a cambiar Rin, empieza por [`docs/developer/README.md`](../docs/developer/README.md).

## Estado del proyecto

Rin avanza hacia un núcleo más limpio, mayor fiabilidad, mejores flujos de instalación y actualización, y una experiencia de asistente cotidiano más útil.

Aún es temprano. Si quieres un producto terminado y totalmente estable, Rin todavía no está ahí. Si quieres probar un asistente local de IA que recuerda, mejora y ya se usa para construirse a sí mismo, eso es lo que Rin intenta llegar a ser.
