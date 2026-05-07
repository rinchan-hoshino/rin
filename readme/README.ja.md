[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [More languages](README.md)

# Rin

> **あなたのコンピューターに住む個人向け AI アシスタント。**<br>
> Rin は重要なことを覚え、実際の作業を手伝い、日々の利用を通じて賢くなります。

Rin は単なるチャット画面ではありません。そばに置いておけるひとつのアシスタントです。ローカルで動き、確認しやすく、許可したツールに接続し、会話をまたいで有用な記憶を保てます。

> [!NOTE]
> Rin は Rin 自身によっても作られています。このプロジェクトでは、Rin が計画、編集、レビュー、翻訳、保守に使われており、自己改善は製品そのもので検証されています。

## ✨ Rin を試す理由

| 欲しいもの                         | Rin が目指すこと                                       |
| ---------------------------------- | ------------------------------------------------------ |
| 同じ説明の繰り返しを減らしたい     | 長期的な事実、好み、プロジェクト、指示を覚える         |
| 使うほど馴染む助手がほしい         | 修正や成功した手順を記憶とスキルに変える               |
| 自分で仕組みを組みたくない         | 記憶、スケジュール、ツール、チャット連携、UI を備える  |
| 何に触れるか確認したい             | ローカルで動き、使うツール、ファイル、設定を示す       |
| ひとつの助手を複数の場所で使いたい | ターミナル、デスクトップアプリ、自動化、チャットへ接続 |

## 🧰 Rin が手伝えること

Rin は汎用アシスタントです。設定に応じて、次のような作業を手伝えます。

- 文書の要約、書き換え、整理
- 最新情報の Web 検索
- ファイルの確認と管理
- リマインダーとスケジュールされたタスクの作成
- 繰り返し作業から長期メモを残すこと
- コードやリポジトリ作業の支援
- 監督下でのローカルコマンドや接続サービスの操作
- ターミナル、デスクトップアプリ、自動化、接続したチャットアプリから同じアシスタントとして応答すること

## 🌱 Rin の違い

### グローバルメモリ

通常のチャットは多くを忘れてしまいます。Rin は長期的な事実や再利用可能な学びを単一の会話の外に保存し、必要なときに戻せます。

### 自然に学習して進化

アシスタントを教えるために、あなたがプロンプトエンジニアになる必要はありません。Rin は繰り返しの修正や成功した手順を、短い指示やスキルへ整理できます。

### バックグラウンドで常駐

Rin は使い捨てのタブではなく、そばに置いておくアシスタントとして設計されています。バックグラウンドプロセスにより、複数のインターフェースが同じアシスタント状態へ接続できます。

### Rin 自身による開発支援

Rin は Rin によって保守されています。このリポジトリは、アシスタントが自分自身の改善を手伝えることの実例です。

## ⚠️ 現在の状態

> [!WARNING]
> Rin はまだ若いソフトウェアです。日常利用でも実験的なものとして扱ってください。粗い部分、不足しているドキュメント、不安定な挙動、破壊的変更に出会う可能性があります。

Rin はコンテキストを保持し、記憶を書き込み、スケジュール作業を実行し、Web 検索を行い、モデルを繰り返し呼び出せるため、単発のチャットより多くのトークン、API クォータ、サブスクリプション容量を使う場合があります。

重要な操作では必ず監督してください。リスクを理解し、結果をレビューまたはロールバックできる場合を除き、不可逆または機密性の高い作業を Rin に任せないでください。

## 🚀 インストール

> [!TIP]
> 多くのユーザーは下の stable インストールコマンドから始めてください。プレリリースと git チャンネルは折りたたみ内にあります。

### Linux と macOS

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh
```

<details>
<summary>その他のリリースチャンネル</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --beta
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --nightly
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git main
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git deadbeef
```

</details>

### Windows

PowerShell または Windows Terminal からインストールします。事前に Node.js と npm が利用可能である必要があります。

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1)))
```

<details>
<summary>その他のリリースチャンネル</summary>

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --beta
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --nightly
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git main
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git deadbeef
```

</details>

Windows では、対話式インストーラーは既定で GUI インストーラーを開きます。インストール後、`rin` は既定でデスクトップ GUI を開き、Rin は GUI ランチャーとユーザー単位のバックグラウンドランタイム用スタートアップランチャーも作成します。

### 既存のチェックアウト

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

## ⌨️ 基本コマンド

```bash
rin            # Rin を開く
rin doctor     # 状態と設定を確認する
rin status     # ライブ worker とスケジュールタスクの活動を表示する
rin start      # バックグラウンドランタイムを開始する
rin stop       # バックグラウンドランタイムを停止する
rin restart    # バックグラウンドランタイムを再起動する
rin update     # インストール済み Rin ランタイムを更新する
rin -p "..."   # 非対話のアシスタントターンを実行する
```

<details>
<summary>🧭 技術読者向け</summary>

Rin は Pi の上に構築され、Pi の KISS 優先の精神を保っています。

- コアを小さく理解しやすく保つ
- 実際のツールとコンテキストをモデルに示す
- それが最も単純で信頼できる設計なら、モデルに判断させる
- モデル固有の小技や過度に調整されたプロンプトに依存しない
- リモートプラットフォームへのロックインより、透明なローカル状態を優先する

Rin は重い agent フレームワークを目指していません。記憶し、行動し、改善しながら、確認可能であり続ける実用的な日常アシスタントを目指しています。

</details>

## 🔄 更新

通常のインストール済み Rin の更新には次を使います。

```bash
rin update              # stable release (default)
rin update --beta       # current weekly beta candidate
rin update --nightly    # current nightly build
rin update --git        # main
rin update --git main
rin update --git deadbeef
```

インストールと更新では stable が既定です。`--beta` は現在の週次 beta 候補、`--nightly` は `main` からの現在の nightly ビルド、接尾辞なしの `--git` は `main` を選びます。

既にインストール済みの Rin を更新する既定の方法として、リポジトリ内の `git pull`、場当たり的な再ビルド、`install.sh` の再実行を使わないでください。

## 📚 ドキュメント

この README は公開ユーザー向けの概要です。翻訳は `readme/README.*.md` にあり、英語版と揃えておく必要があります。

Rin 本体を変更する場合は、[`docs/developer/README.md`](../docs/developer/README.md) から始めてください。agent 向けランタイムガイドとインストール済みドキュメントは、この公開 README とは分けて管理されています。
