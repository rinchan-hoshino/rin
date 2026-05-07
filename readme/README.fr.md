[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [More languages](README.md)

# Rin

> **Votre assistant IA personnel, vivant sur votre ordinateur.**<br>
> Rin se souvient de ce qui compte, aide sur de vraies tâches et s'améliore avec l'usage.

Rin est un assistant IA local et généraliste avec mémoire, outils, planification, interfaces et passerelles de chat intégrés. Rin est aussi construit avec Rin : le projet utilise son propre assistant pour planifier, éditer, relire, traduire et maintenir ce dépôt.

> [!WARNING]
> Rin est encore jeune. Considérez l'usage quotidien comme expérimental : vous pouvez rencontrer des zones rugueuses, une documentation incomplète, des comportements instables, des coûts de tokens/API ou parfois des changements incompatibles.

## Installation

> [!TIP]
> La plupart des utilisateurs devraient commencer par la commande stable ci-dessous. Les canaux préversion et git sont dans les sections pliées.

### Linux et macOS

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh
```

<details>
<summary>Autres canaux de publication</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --beta
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --nightly
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git main
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git deadbeef
```

</details>

### Windows

Installez depuis PowerShell ou Windows Terminal. Node.js et npm doivent d'abord être disponibles.

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1)))
```

<details>
<summary>Autres canaux de publication</summary>

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --beta
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --nightly
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git main
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git deadbeef
```

</details>

Sous Windows, l'installateur interactif ouvre par défaut l'installateur GUI. Après installation, `rin` ouvre par défaut la GUI de bureau, et Rin écrit aussi des lanceurs GUI ainsi qu'un lanceur de démarrage par utilisateur pour le runtime en arrière-plan.

## Utilisation de base

```bash
rin            # ouvrir Rin
rin -p "..."   # lancer un tour d'assistant ponctuel
rin doctor     # inspecter l'état de santé et la configuration
```

## Capacités

Rin est conçu pour le travail quotidien d'un assistant, pas seulement pour coder :

- mémoriser des faits durables, préférences, projets et consignes récurrentes
- résumer, réécrire et organiser des documents
- rechercher des informations récentes sur le web
- inspecter et gérer des fichiers
- créer des rappels et des tâches planifiées
- conserver des notes à long terme à partir de travaux répétés
- aider avec du code et des dépôts
- exécuter des commandes locales ou agir sur des services connectés sous votre supervision
- répondre depuis le terminal, l'application de bureau, des automatisations ou des chats connectés comme le même assistant

## Fonctionnalités clés

| Fonctionnalité                | Ce que cela signifie                                                          |
| ----------------------------- | ----------------------------------------------------------------------------- |
| Mémoire globale               | Les faits et apprentissages utiles peuvent survivre à une seule conversation. |
| Apprend par l'usage répété    | Corrections et workflows réussis peuvent devenir consignes et compétences.    |
| Runtime local en arrière-plan | Plusieurs interfaces peuvent se connecter au même état d'assistant.           |
| Produit prêt à l'emploi       | Mémoire, planification, outils, chat bridges et interfaces sont inclus.       |
| Auto-amorçage                 | Rin sert à construire Rin ; le dépôt est un test vivant du workflow.          |

## Sécurité et coûts

Rin peut garder du contexte, écrire de la mémoire, exécuter des tâches planifiées, chercher sur le web et appeler des modèles à répétition. Cela peut consommer plus de tokens de modèle, de quota d'API ou de capacité d'abonnement qu'un chat ponctuel.

Gardez la supervision pour les actions importantes. Ne laissez pas Rin effectuer des actions irréversibles ou sensibles sauf si vous comprenez le risque et pouvez vérifier ou annuler le résultat.

<details>
<summary>Direction technique</summary>

Rin est construit sur Pi et conserve son esprit KISS :

- garder le cœur petit et compréhensible
- montrer au modèle les vrais outils et le vrai contexte
- laisser le modèle décider lorsque c'est la conception la plus simple et fiable
- éviter les astuces propres à un modèle et les prompts trop réglés
- préférer un état local transparent au verrouillage par une plateforme distante

Rin ne cherche pas à devenir un framework d'agents lourd. Il cherche à être un assistant quotidien pratique, capable de se souvenir, d'agir et de s'améliorer tout en restant inspectable.

</details>

## Documentation

Ce README est la vue d'ensemble publique pour les utilisateurs. Les traductions se trouvent dans `readme/README.*.md` et doivent rester alignées avec cette version anglaise.

Si vous modifiez Rin lui-même, commencez par [`docs/developer/README.md`](../docs/developer/README.md). Les guides runtime destinés aux agents et la documentation installée sont séparés de ce README public.
