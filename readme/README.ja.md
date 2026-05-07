[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [More languages](README.md)

# Rin

> **あなたのコンピューターに住む個人向け AI アシスタント。**<br>
> Rin は重要なことを覚え、実際の作業を手伝い、使うほど賢くなります。

Rin はローカルで動く汎用 AI アシスタントです。記憶、ツール、スケジュール、UI 入口、チャット連携を備えています。Rin は Rin 自身によっても作られており、このプロジェクトは自分のアシスタントを使って計画、編集、レビュー、翻訳、保守を行っています。

> [!WARNING]
> Rin はまだ若いソフトウェアです。日常利用でも実験的なものとして扱ってください。粗い部分、不足しているドキュメント、不安定な挙動、トークン/API コスト、破壊的変更に出会う可能性があります。

## インストール

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

## 基本的な使い方

```bash
rin            # Rin を開く
rin -p "..."   # 1 回だけのアシスタントターンを実行する
rin doctor     # 状態と設定を確認する
```

## できること

Rin は日常的なアシスタント作業のために設計されており、コーディング専用ではありません。

- 長期的な事実、好み、プロジェクト、繰り返し使う指示を覚える
- 文書の要約、書き換え、整理
- 最新情報の Web 検索
- ファイルの確認と管理
- リマインダーとスケジュールタスクの作成
- 繰り返し作業から長期メモを残す
- コードやリポジトリ作業の支援
- 監督下でのローカルコマンドや接続サービスの操作
- ターミナル、デスクトップアプリ、自動化、接続したチャットアプリから同じアシスタントとして応答

## 主な特徴

| 特徴                           | 意味                                                            |
| ------------------------------ | --------------------------------------------------------------- |
| グローバルメモリ               | 有用な事実や学びを単一のチャットの外に残せます。                |
| 繰り返し利用から学習           | 修正や成功した手順を短い指示やスキルにできます。                |
| ローカルのバックグラウンド動作 | 複数のインターフェースが同じアシスタント状態に接続できます。    |
| すぐ使える製品                 | 記憶、スケジュール、ツール、チャット連携、UI が含まれます。     |
| 自己ブートストラップ           | Rin は Rin の開発に使われ、このリポジトリ自体が実地テストです。 |

## 安全性とコスト

Rin はコンテキストを保持し、記憶を書き込み、スケジュール作業を実行し、Web 検索を行い、モデルを繰り返し呼び出せます。そのため、単発のチャットより多くのトークン、API クォータ、サブスクリプション容量を使う場合があります。

重要な操作では必ず監督してください。リスクを理解し、結果をレビューまたはロールバックできる場合を除き、不可逆または機密性の高い作業を Rin に任せないでください。

<details>
<summary>技術的な方向性</summary>

Rin は Pi の上に構築され、Pi の KISS 優先の精神を保っています。

- コアを小さく理解しやすく保つ
- 実際のツールとコンテキストをモデルに示す
- それが最も単純で信頼できる設計なら、モデルに判断させる
- モデル固有の小技や過度に調整されたプロンプトに依存しない
- リモートプラットフォームへのロックインより、透明なローカル状態を優先する

Rin は重い agent フレームワークを目指していません。記憶し、行動し、改善しながら、確認可能であり続ける実用的な日常アシスタントを目指しています。

</details>

## ドキュメント

この README は公開ユーザー向けの概要です。翻訳は `readme/README.*.md` にあり、英語版と揃えておく必要があります。

Rin 本体を変更する場合は、[`docs/developer/README.md`](../docs/developer/README.md) から始めてください。agent 向けランタイムガイドとインストール済みドキュメントは、この公開 README とは分けて管理されています。
