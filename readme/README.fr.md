[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [More languages](README.md)

# Rin

> **Votre assistant IA personnel, vivant sur votre ordinateur.**<br>
> Rin se souvient de ce qui compte, aide sur de vraies tâches et s'améliore avec l'usage.

Rin est un assistant IA local et généraliste avec mémoire, outils, planification, interfaces et passerelles de chat intégrés. Il peut aider avec les documents, la recherche web, les fichiers, les rappels, le code, les services connectés et les workflows répétés, tout en partageant un même état d'assistant entre terminal, bureau, automatisation et chat.

| Ce qui compte                 | Ce que Rin fournit                                                               |
| ----------------------------- | -------------------------------------------------------------------------------- |
| Mémoire globale               | Faits, préférences et apprentissages utiles peuvent survivre à un seul chat.     |
| Apprend par l'usage répété    | Corrections et workflows réussis peuvent devenir consignes et compétences.       |
| Runtime local en arrière-plan | Plusieurs entrées se connectent au même assistant, pas à des fenêtres isolées.   |
| Produit prêt à l'emploi       | Mémoire, planification, outils, chat bridges et interfaces sont inclus.          |
| Auto-amorçage                 | Rin sert à construire Rin ; le dépôt est un test vivant de l'assistant lui-même. |

> [!WARNING]
> Rin est encore jeune. Considérez l'usage quotidien comme expérimental : vous pouvez rencontrer des zones rugueuses, une documentation incomplète, des comportements instables, des coûts de tokens/API ou parfois des changements incompatibles.

## Installation

> [!TIP]
> La plupart des utilisateurs devraient commencer par la commande stable ci-dessous. Les canaux préversion et git sont dans les sections pliées.

Rin nécessite Node.js 22.19.0 ou une version ultérieure et npm sur toutes les plateformes.

### Linux et macOS

```bash
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh
```

<details>
<summary>Autres canaux de publication</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh -s -- --beta
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh -s -- --nightly
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh -s -- --git
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh -s -- --git main
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh -s -- --git deadbeef
```

</details>

### Windows

Installez depuis PowerShell ou Windows Terminal.

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1)))
```

<details>
<summary>Autres canaux de publication</summary>

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1))) --beta
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1))) --nightly
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1))) --git
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1))) --git main
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1))) --git deadbeef
```

</details>

Sous Windows, l'installateur interactif ouvre par défaut l'installateur GUI. Après installation, `rin` ouvre par défaut la GUI de bureau, et Rin écrit aussi des lanceurs GUI ainsi qu'un lanceur de démarrage par utilisateur pour le runtime en arrière-plan.

## Sécurité et coûts

Rin peut garder du contexte, écrire de la mémoire, exécuter des tâches planifiées, chercher sur le web et appeler des modèles à répétition. Cela peut consommer plus de tokens de modèle, de quota d'API ou de capacité d'abonnement qu'un chat ponctuel.

Gardez la supervision pour les actions importantes. Ne laissez pas Rin effectuer des actions irréversibles ou sensibles sauf si vous comprenez le risque et pouvez vérifier ou annuler le résultat.

## Direction technique

Rin est construit sur Pi et conserve son esprit KISS :

- garder le cœur petit et compréhensible
- montrer au modèle les vrais outils et le vrai contexte
- laisser le modèle décider lorsque c'est la conception la plus simple et fiable
- éviter les astuces propres à un modèle et les prompts trop réglés
- préférer un état local transparent au verrouillage par une plateforme distante

Rin ne cherche pas à devenir un framework d'agents lourd. Il cherche à être un assistant quotidien pratique, capable de se souvenir, d'agir et de s'améliorer tout en restant inspectable.

## Documentation

Ce README est la vue d'ensemble publique pour les utilisateurs. Les traductions se trouvent dans `readme/README.*.md` et doivent rester alignées avec cette version anglaise.

Si vous modifiez Rin lui-même, commencez par [`docs/developer/README.md`](../docs/developer/README.md). Les guides runtime destinés aux agents et la documentation installée sont séparés de ce README public.
