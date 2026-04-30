[English](../README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Français](README.fr.md) | [Más idiomas](README.md)

# Rin

> Nota: esta es una traducción de conveniencia. La versión canónica es el README en inglés (`../README.md`) y puede actualizarse antes.

Un asistente local de IA, centrado en la terminal, que puede conversar, editar archivos, recordar cosas, buscar en la web y ejecutar tareas programadas.

## Qué es Rin

Rin no está pensado solo para sesiones aisladas con un agente de código.

La idea es tener un asistente local que puedas mantener en tu terminal para el trabajo diario:

- pedir cosas en lenguaje natural
- inspeccionar y modificar archivos
- conservar memoria útil a largo plazo
- programar recordatorios y tareas recurrentes
- consultar información reciente en la web
- conectar el mismo asistente a plataformas de chat mediante un puente de chat

El objetivo es simple: que el agente se sienta como una herramienta con la que realmente puedas convivir, no solo como una capa alrededor de un modelo.

## Por qué Rin

Rin se centra en unas pocas bases:

- flujo de trabajo orientado a la terminal
- memoria integrada, no solo chats sin estado
- tareas programadas integradas
- búsqueda web integrada para preguntas sensibles al tiempo
- soporte integrado de puente de chat
- un único punto de entrada del producto: `rin`

Si quieres un asistente que siga siendo útil con el tiempo, Rin está diseñado para eso.

## Inicio rápido

Instalación:

```bash
./install.sh
```

Luego abre Rin:

```bash
rin
```

Comprueba el estado si hace falta:

```bash
rin doctor
```

El instalador te advertirá sobre los límites de seguridad y el posible uso adicional de tokens. Ese coste extra puede venir de la inicialización, el procesamiento de memoria, los resúmenes, las ejecuciones no interactivas de `rin -p` / `rin --mode json`, las tareas programadas y la búsqueda web.

### Escenarios de despliegue

El instalador sigue siendo local, pero estas formas de despliegue ya son viables como envoltorios de los mismos puntos de entrada de Linux/macOS/Windows. El entorno de destino debe cumplir los requisitos normales de Rin, incluidos Node.js y npm:

| Escenario                             | Viabilidad                                                    | Notas                                                                                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Instalación local o para otro usuario | Soportada hoy                                                 | El instalador interactivo puede apuntar a la cuenta actual o a otro usuario local, y escribe los lanzadores y el servicio daemon de ese usuario.                                                                                     |
| Instalación por SSH                   | Viable hoy                                                    | Ejecuta el comando bootstrap por SSH en el host remoto. Un envoltorio dedicado `rin install --ssh` podría mejorar más adelante la detección y los errores.                                                                           |
| Instalación en contenedor             | Viable con una imagen Linux sin interfaz gráfica              | Usa un volumen persistente para el home/directorio de instalación de Rin y ejecuta el daemon o la CLI dentro del contenedor. Los lanzadores GUI y los servicios de usuario del host no aplican dentro del contenedor.                |
| Instalación en máquina virtual        | Soportada mediante el instalador normal del sistema operativo | Instala Rin dentro del sistema invitado igual que en una máquina física. Las instantáneas de la VM facilitan la reversión, pero Rin solo gestiona el entorno invitado.                                                               |
| Instalación en NAS                    | Viable cuando el NAS puede ejecutar Node.js o contenedores    | En NAS abiertos, prefiere la ruta Linux normal; en dispositivos NAS cerrados, prefiere el patrón de contenedor. Los gestores de paquetes del fabricante y las shells restringidas pueden requerir notas específicas del dispositivo. |
| Instalación en la nube                | Soportada mediante SSH o bootstrap tipo cloud-init            | Trata la VM en la nube como un host Linux remoto. Conserva los datos `.rin` en un disco duradero y configura el arranque del daemon según el sistema operativo del host.                                                             |

Estos son escenarios de despliegue, no canales de publicación separados. Stable, beta, nightly y git siguen usando el mismo contrato de instalación/actualización anterior.

## Qué puedes pedirle a Rin

Cuando Rin esté abierto, simplemente háblale.

Ejemplos:

- `Revisa este directorio y dime qué es importante.`
- `Reescribe este README.`
- `Ordena este archivo de configuración.`
- `Recuerda que prefiero respuestas cortas.`
- `Recuérdame mañana por la tarde que revise los logs.`
- `Busca la documentación oficial más reciente de esta herramienta.`
- `Vigila esta carpeta cada hora y avísame si cambia algo.`

## Comandos principales

```bash
rin            # abrir Rin
rin doctor     # revisar estado y configuración
rin target     # listar y elegir destinos de despliegue
rin --target x # ejecutar Rin en un destino configurado
rin start      # iniciar el daemon
rin stop       # detener el daemon
rin restart    # reiniciar el daemon
rin update     # actualizar Rin
```

## Capacidades integradas clave

Rin ya trae conectadas varias funciones importantes:

- memoria a largo plazo
- tareas programadas y recordatorios
- búsqueda web en vivo
- cobertura de puente de chat para Telegram, OneBot, Discord, Kook, QQ, Lark, Mail, WeChat Official, WeCom, DingTalk, Matrix, WhatsApp, LINE, Slack y Zulip
- `rin -p` / `rin --mode json` no interactivo para delegar trabajo y ejecutar turnos de agente programables

## Cuándo usar `rin --std`

Lo normal es usar `rin`.

`rin --std` es sobre todo una alternativa de diagnóstico cuando el modo RPC por defecto tiene problemas y necesitas una sesión en primer plano para recuperar o depurar.

## Documentación

Este README es la documentación para usuarios. Las traducciones viven en `readme/README.*.md` y deben mantenerse alineadas con la versión inglesa; actualízalas en el mismo cambio cuando cambie contenido visible para usuarios.

La documentación interna está separada:

- La guía de runtime para agentes vive en `docs/agent/` y se instala en `agentDir/docs/rin/`.
- La documentación técnica para desarrolladores vive en `docs/developer/`.
- Los metadatos de notas de versión usados por `/changelog` y los flujos de publicación viven en `docs/release/CHANGELOG.md`.

## Versión corta

Instálalo, ejecuta `rin` y pídele lo que necesites.

Esa es la idea principal de Rin.
