---
title: 'NFCデジタル名刺を Next.js + AWS で運用コスト0で作った話'
emoji: '💳'
type: 'tech'
topics: ['nextjs', 'aws', 'terraform', 'cloudfront', 'githubactions']
published: false
---

## はじめに

イベントや勉強会で出会った人に、自分の経歴・スキル・SNS リンクをまとめて渡す方法をずっと探していました。紙の名刺は情報量が限られ、QRコードを毎回見せるのも少し野暮ったい。

そこで、**NFCタグに自分のポートフォリオサイトのURLを書き込み、相手のスマホをかざすだけで開けるデジタル名刺** を作りました。本記事では、何を作ったか・どんな構成か・特に AWS のインフラ・CI/CD・IaC をどう組んだかを、簡単に解説します。
みんなもスマートな名刺交換を始めませんか！

:::message
タイトルで運用コスト0と書きましたが、**ほぼ**0です。許してください。
少なくともこのサイトを開発してから1ヶ月弱経ちますが今の所**運用コストは0**です！！

また、本記事の構成図および一部の文章作成に AI を活用しています。
ただし、**すべての内容は筆者が確認・推敲しており、文章の大部分は人間（筆者）が執筆**
しています。
:::

## 何を作ったか

百聞は一見にしかずなので、まずは実際の挙動から。

### NFCタップから表示までのデモ

<!-- TODO: NFCタップ → サイトが開くまでのデモ動画を挿入 -->

![NFCタップのデモ](TODO: 動画URL)

### 表示されるサイト

シンプルな1ページ構成で以下の3セクション構成となっています。

- Hero（プロフィール）
- Skills（スキル一覧）
- Contact（SNSリンク）

![Heroセクション](/images/digital-business-card-aws/hero.png)

スクロール後の Skills / Contact セクションは、実際のサイトでご覧ください👇

🔗 サイトURL: [デジタル名刺ポートフォリオ](https://dag5f6i833qe.cloudfront.net/)

### 運用フロー

仕組みはとてもシンプルです。

1. NFCタグに、サイトのURLを書き込む
2. 相手のスマホ（iPhone / Android）をかざすと、ブラウザでサイトが自動で開く

## 全体構成

全体像を先にお見せします。

![全体構成](/images/digital-business-card-aws/aws_archi.png)

ざっくり次の3レイヤです。

- **フロント**:
  - Next.jsで構成
  - `output: "export"` で静的書き出し
- **インフラ**:
  - AWS S3 + CloudFront + OAC
  - S3 へのアクセスは CloudFront からのみに限定
- **運用基盤**:
  - Terraform
  - GitHub Actions + OIDC
  - AWS Budgets でコスト監視

## AWS構成の詳細

### なぜ S3 + CloudFront + OAC を選んだか

このサイトは **完全に静的** です。SSR も DB も不要。であれば、

- **S3 だけで配信**: HTTPS が直接張れない、独自ドメイン運用に不便
- **EC2 / ECS で配信**: 完全にオーバースペック。常時稼働コストも痛い
- **Amplify / Vercel**: 楽だが、AWS のコントロール権を持っておきたかった

という比較から、**S3 + CloudFront + OAC** を選びました。これは AWS で静的サイトを公開する際の事実上の標準構成です。

### キャッシュ戦略

CloudFront のキャッシュ TTL は **HTML と静的アセットで明確に分離** します。

| パス                        | ブラウザ TTL | CDN TTL           | 理由                                               |
| --------------------------- | ------------ | ----------------- | -------------------------------------------------- |
| `/`, `/index.html` 等のHTML | 300秒        | 86400秒           | デプロイで内容が更新される                         |
| `/_next/static/*`           | 1年          | 1年 (`immutable`) | ファイル名にハッシュが付くため永続キャッシュで安全 |

Next.js は静的アセットのファイル名にコンテンツハッシュを埋め込みます。**内容が変われば URL が変わる** ので、`/_next/static/` 配下は1年キャッシュしても古いものが返ることがありません。一方 HTML は同じ URL のまま中身が差し変わるので、短めの TTL にしておきます。

### コストは完全無料を目指した

このサイトの月額コストは、**通常運用ではほぼ $0** です。具体的には次のような内訳になります。

| サービス                       | 想定月額         | 備考                                                 |
| ------------------------------ | ---------------- | ---------------------------------------------------- |
| S3 ストレージ                  | < $0.01          | サイト全体で数MB                                     |
| S3 リクエスト                  | < $0.01          | アクセスは基本 CloudFront 経由なので S3 GET は少ない |
| CloudFront 転送量              | $0 〜 数十セント | 1TB/月までの永久無料枠あり（AWS無料利用枠）          |
| Route 53（独自ドメイン使用時） | $0.50            | ホストゾーン1つ                                      |
| AWS Budgets                    | $0               | 2予算まで無料                                        |

ポイントは **CloudFront の永久無料枠**。データ転送 1TB/月、リクエスト 1000万/月までが無料で、ポートフォリオ用途ならまず使い切れません。

### 想定外の請求を防ぐ AWS Budgets

個人運用で一番怖いのは、何かの拍子に発生する想定外の請求です。`budgets.tf` に **月額 $1 を閾値** にした AWS Budgets を仕込み、**80% / 100% 実績 / 100% 予測** の3段階で SNS 経由のメール通知を飛ばしています。

## CI/CDワークフロー

### ジョブの全体像

`.github/workflows/deploy.yml` で、**main ブランチへの push をトリガに自動デプロイ** が走ります。

```yaml
on:
  push:
    branches: [main]

permissions:
  id-token: write # OIDC のために必須
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ap-northeast-1

      - run: aws s3 sync ./out s3://$BUCKET --delete
      - run: |
          aws cloudfront create-invalidation \
            --distribution-id $DIST_ID --paths "/*"
```

### OIDC による鍵レス認証

CI からの AWS デプロイは「IAMユーザーの Access Key を発行 → GitHub Secrets に保存」も一つの手ですが、**長寿命のクレデンシャルは漏洩リスクの最大要因** です。

そこで GitHub OIDC による鍵レス認証を採用しました。仕組みは下図のとおりです。

![OIDCによる鍵レス認証の仕組み](/images/digital-business-card-aws/oidc.png)

ポイントは2つです。

- **AssumeRoleWithWebIdentity**: GitHub Actions の OIDCトークン（署名入りJWT）を AWS STS に渡し、**一時クレデンシャル（通常1時間で失効）** を得る。長期の Access Key は一切不要
- **信頼ポリシーの Condition**: `sub` クレームで「**特定リポジトリ + 特定ブランチ**」に限定。フォーク・別ブランチ・別リポジトリからは AssumeRole 不可

`permissions: id-token: write` がないと OIDC トークン自体が発行されず、認証ステップで即失敗します。地味ですがハマりやすい一行なので必ず押さえてください。

なお、本番運用では `Condition` に `aud`（audience）の StringEquals も追加するのがベストプラクティスです（期待値: `sts.amazonaws.com`）。

### デプロイフロー（build → S3 sync → CF invalidation）

実際のデプロイは3ステップで完結します。

1. **build**: `npm run build` で `out/` に静的ファイルを生成
2. **S3 sync**: `aws s3 sync ./out s3://$BUCKET --delete` で、**差分だけアップロード + 不要ファイルを削除**
3. **CloudFront invalidation**: `aws cloudfront create-invalidation --paths "/*"` で CDN キャッシュをパージ

`--delete` オプションを付けることで、リネーム・削除されたファイルが S3 上に残り続ける事故を防げます。CloudFront のキャッシュ無効化（Invalidation）は **月1000パスまで無料**、それを超えると $0.005/パス なので、`/*` 1本にまとめておくのが個人開発では合理的です。

## IaCでの管理

### infra/ のディレクトリ構成

`infra/` ディレクトリに Terraform ファイルをまとめ、**役割ごとにファイルを分割** しています。

```text
infra/
├── s3.tf            # 静的サイト用バケットと OAC
├── cloudfront.tf    # ディストリビューションとキャッシュポリシー
├── github_oidc.tf   # GitHub Actions 用 OIDC プロバイダと IAM ロール
├── budgets.tf       # コストアラート
├── variables.tf     # 入力変数
├── outputs.tf       # 出力値（バケット名・ディストリビューションID）
└── ...
```

リソース種別ごとにファイルを切ることで、PR レビュー時の差分が読みやすくなり、1ファイル肥大化も避けられます。リージョンは東京（`ap-northeast-1`）。CloudFront 用の ACM 証明書だけは仕様上 `us-east-1` に置く必要がある点に注意です。

### なぜ Terraform でIaC化するか

下記の理由で今回Terraformを採用しました。

- **インフラの差分が PR 上で確認できる**: コンソールでポチポチした内容は、未来の自分が思い出せません
- **再現性が高い**: 別アカウントへの引っ越しや、災害復旧時の作り直しが `terraform apply` 一発
- **手動操作で構成が壊れた時に気付ける**: `terraform plan` で「想定と違う差分」が浮き出るので、知らぬ間にコンソールで誰か（過去の自分含む）が触った変更にすぐ気付ける
- **Terraform使ってみたかった！！(これが最大の理由)**

### State 管理の方針

Terraform の `tfstate` には、リソースID・ARN・パラメータが平文で保存されます。**ローカルに置いたまま git に上げる**のは事故のもとです。

このプロジェクトでは、

- `tfstate` は **S3 リモートバックエンド**（SSE-S3 で暗号化）
- 同時 apply を防ぐため **DynamoDB ロック**
- ステート用バケットは別アカウント・別ライフサイクルで管理

としています。State の運用設計は、別記事でもっと深く掘る予定です。

## まとめ

NFCで配るデジタル名刺を、次の構成で実装しました。

- **フロント**: Next.js 16（Static Export）+ React 19 + Tailwind CSS 4 + Framer Motion
- **AWS インフラ**: S3 + CloudFront + OAC（パブリックアクセス全閉）
- **CI/CD**: GitHub Actions + OIDC（鍵レス）、main push で自動デプロイ
- **IaC**: Terraform でインフラを完全コード管理、State は S3+DynamoDB
- **コスト管理**: AWS Budgets で月 $1 アラート
- **NFC**: タグに URL を NDEF 形式で書き込むだけ。サイト側に特別な実装は不要

ポイントは、サイトそのものの実装を最小に抑え、**「URLをタップした瞬間に開く体験」** を AWS の CDN 構成と GitHub Actions の自動デプロイで支えていること。
すべて標準的な AWS の道具で組み立てられるのが今回の構成です。

気になった構成・実装があれば、ぜひコメントで教えてください。
