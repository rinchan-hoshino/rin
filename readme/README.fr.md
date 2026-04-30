[English](../README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Français](README.fr.md) | [Plus de langues](README.md)

# Rin

> Remarque : cette traduction est fournie pour plus de confort. La version de référence est le README anglais (`../README.md`), qui peut être mise à jour plus tôt.

Un assistant IA local, centré sur le terminal, capable de discuter, modifier des fichiers, mémoriser des informations, chercher sur le web et exécuter des tâches planifiées.

## Qu’est-ce que Rin ?

Rin n’est pas seulement un agent de code pour des sessions ponctuelles.

L’idée est d’avoir un assistant local que vous pouvez garder dans votre terminal pour le travail au quotidien :

- demander des choses en langage naturel
- inspecter et modifier des fichiers
- conserver une mémoire utile à long terme
- définir des rappels et des tâches récurrentes
- consulter des informations récentes sur le web
- relier le même assistant à des plateformes de chat via un pont de chat

L’objectif est simple : faire en sorte que l’agent ressemble à un vrai outil de travail au long cours, pas seulement à une fine couche autour d’un modèle.

## Pourquoi Rin ?

Rin se concentre sur quelques bases :

- un workflow orienté terminal
- une mémoire intégrée, pas seulement des conversations sans état
- des tâches planifiées intégrées
- une recherche web intégrée pour les questions sensibles au temps
- la prise en charge intégrée d’un pont de chat
- un point d’entrée unique : `rin`

Si vous voulez un assistant utile sur la durée, Rin est conçu pour cela.

## Démarrage rapide

Installation :

```bash
./install.sh
```

Puis lancez Rin :

```bash
rin
```

Vérifiez l’état si nécessaire :

```bash
rin doctor
```

L’installateur vous avertira des limites de sécurité et de la possibilité d’une consommation supplémentaire de jetons. Ce coût supplémentaire peut venir de l’initialisation, du traitement de la mémoire, des résumés, des exécutions non interactives `rin -p` / `rin --mode json`, des tâches planifiées et de la recherche web.

## Ce que vous pouvez demander à Rin

Une fois Rin ouvert, parlez-lui simplement.

Exemples :

- `Parcours ce répertoire et dis-moi ce qui est important.`
- `Réécris ce README.`
- `Nettoie ce fichier de configuration.`
- `Souviens-toi que je préfère des réponses courtes.`
- `Rappelle-moi demain après-midi de vérifier les logs.`
- `Cherche la documentation officielle la plus récente pour cet outil.`
- `Surveille ce dossier toutes les heures et dis-moi s’il change.`

## Commandes principales

```bash
rin            # ouvrir Rin
rin doctor     # vérifier l’état et la configuration
rin start      # démarrer le daemon
rin stop       # arrêter le daemon
rin restart    # redémarrer le daemon
rin update     # mettre à jour Rin
```

## Capacités intégrées principales

Rin inclut déjà plusieurs briques importantes :

- mémoire à long terme
- tâches planifiées et rappels
- recherche web en direct
- couverture de pont de chat pour Telegram, OneBot, Discord, Kook, QQ, Lark, Mail, WeChat Official, WeCom, DingTalk, Matrix, WhatsApp, LINE, Slack et Zulip
- `rin -p` / `rin --mode json` non interactif pour déléguer du travail et lancer des tours agent scriptables

## Quand utiliser `rin --std`

En temps normal, utilisez `rin`.

`rin --std` sert surtout de solution de repli pour le dépannage lorsque le mode RPC par défaut a un problème et que vous avez besoin d’une session au premier plan pour réparer ou déboguer.

## Documentation

Ce README est la documentation utilisateur. Les traductions se trouvent dans `readme/README.*.md` et doivent rester alignées avec la version anglaise ; mettez-les à jour dans le même changement lorsque le contenu visible par les utilisateurs change.

La documentation interne est séparée :

- La documentation de runtime destinée aux agents se trouve dans `docs/agent/` et est installée dans `agentDir/docs/rin/`.
- La documentation technique destinée aux développeurs se trouve dans `docs/developer/`.
- Les métadonnées de notes de version utilisées par `/changelog` et les workflows de publication se trouvent dans `docs/release/CHANGELOG.md`.

## Version courte

Installez-le, lancez `rin`, puis demandez ce dont vous avez besoin.

C’est l’idée principale de Rin.
