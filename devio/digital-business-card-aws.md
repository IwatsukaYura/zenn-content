---
title: "Building an NFC Digital Business Card with Next.js + AWS at Zero Operating Cost"
tags: ["nextjs", "aws", "terraform", "githubactions"]
published: false
canonicalUrl: ""
---

## Introduction

I had been looking for a better way to share my background, skills, and SNS links with the people I meet at events and meetups. Paper business cards carry limited information, and pulling out a QR code every time felt a bit clunky.

So I built a **digital business card where the URL of my portfolio site is written to an NFC tag — the other person just needs to tap their smartphone against it to open the page**. In this article, I'll briefly walk through what I built, what the architecture looks like, and in particular how I set up the AWS infrastructure, CI/CD, and IaC.

Let's start exchanging business cards in a smarter way!

> **Note**
> The title says "zero operating cost," but it's actually **almost** zero. Please forgive me.
> That said, in the roughly one month since I started running this site, the **operating cost has genuinely been $0**!
>
> Also, the architecture diagram and parts of the text in this article were created with the help of AI.
> However, **everything has been reviewed and refined by me, and the majority of the prose was written by a human (me)**.

## What I Built

A picture is worth a thousand words, so let me start with the actual behavior.

### Demo: From NFC tap to page rendered

![NFC tap demo](https://raw.githubusercontent.com/IwatsukaYura/zenn-content/main/images/digital-business-card-aws/record_for_card.gif)

*Note: the GIF is heavily compressed to keep the file size down, so the image quality is a bit rough.*

### The site itself

A simple single-page layout with three sections:

- Hero (profile)
- Skills (skill list)
- Contact (SNS links)

![Hero section](https://raw.githubusercontent.com/IwatsukaYura/zenn-content/main/images/digital-business-card-aws/hero.png)

For the Skills / Contact sections after scrolling, please take a look at the live site 👇

🔗 Site URL: [Digital Business Card Portfolio](https://dag5f6i833qe.cloudfront.net/)

### The flow

The mechanism is very simple.

1. Write the site's URL to an NFC tag
2. When the other person taps their smartphone (iPhone / Android) on the tag, the browser opens the site automatically

## Overall Architecture

Here's the big picture upfront.

![Overall architecture](https://raw.githubusercontent.com/IwatsukaYura/zenn-content/main/images/digital-business-card-aws/aws_archi.png)

Roughly speaking, there are three layers:

- **Frontend**:
  - Built with Next.js
  - Static export via `output: "export"`
- **Infrastructure**:
  - AWS S3 + CloudFront + OAC
  - Access to S3 is restricted to CloudFront only
- **Operations**:
  - Terraform
  - GitHub Actions + OIDC
  - AWS Budgets for cost monitoring

## AWS Architecture in Detail

### Why I chose S3 + CloudFront + OAC

This site is **fully static**. No SSR, no DB required. Given that:

- **S3 alone**: Cannot terminate HTTPS directly, and operating a custom domain is inconvenient
- **EC2 / ECS**: Completely overkill. The always-on cost also hurts
- **Amplify / Vercel**: Easy, but I wanted to keep AWS-side control

From this comparison, I chose **S3 + CloudFront + OAC**. This is essentially the de facto standard for hosting a static site on AWS.

### Caching strategy

CloudFront's cache TTL is **clearly separated between HTML and static assets**.

| Path                          | Browser TTL | CDN TTL              | Reason                                                  |
| ----------------------------- | ----------- | -------------------- | ------------------------------------------------------- |
| HTML such as `/`, `/index.html` | 300 sec     | 86400 sec            | Content gets updated on each deploy                     |
| `/_next/static/*`             | 1 year      | 1 year (`immutable`) | Filenames contain a hash, so permanent caching is safe  |

Next.js embeds a content hash into the filenames of static assets. **If the content changes, the URL changes**, so it is safe to cache anything under `/_next/static/` for a year without ever serving stale files. HTML, on the other hand, keeps the same URL while its content changes, so we use a shorter TTL.

### Aiming for completely free operation

The monthly cost for this site is **essentially $0 under normal operation**. Here's a breakdown:

| Service                              | Estimated monthly cost | Note                                                              |
| ------------------------------------ | ---------------------- | ----------------------------------------------------------------- |
| S3 storage                           | < $0.01                | The whole site is a few MB                                        |
| S3 requests                          | < $0.01                | Access goes through CloudFront, so S3 GETs are minimal            |
| CloudFront data transfer             | $0 ~ a few cents       | The AWS Free Tier includes a permanent 1 TB/month allowance       |
| Route 53 (if using a custom domain)  | $0.50                  | One hosted zone                                                   |
| AWS Budgets                          | $0                     | Up to two budgets are free                                        |

The key here is the **CloudFront permanent free tier**. Up to 1 TB/month of data transfer and 10 million requests/month are free, which is more than enough for a portfolio.

### Preventing surprise bills with AWS Budgets

The scariest thing about personal operation is an unexpected bill out of nowhere. I have set an AWS Budget in `budgets.tf` with a **$1 monthly threshold**, sending email notifications via SNS at **80% / 100% actual / 100% forecast** — three stages in total.

## CI/CD Workflow

### The overall job

In `.github/workflows/deploy.yml`, **a push to the main branch triggers automatic deployment**.

```yaml
on:
  push:
    branches: [main]

permissions:
  id-token: write # required for OIDC
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

### Keyless authentication with OIDC

One option for deploying to AWS from CI is "create an IAM user, issue an access key, and store it in GitHub Secrets," but **long-lived credentials are the biggest source of leak risk**.

So I went with keyless authentication via GitHub OIDC. The mechanism looks like this:

![How OIDC keyless authentication works](https://raw.githubusercontent.com/IwatsukaYura/zenn-content/main/images/digital-business-card-aws/oidc.png)

There are two key points:

- **AssumeRoleWithWebIdentity**: The OIDC token (a signed JWT) issued by GitHub Actions is exchanged with AWS STS for **temporary credentials (usually valid for one hour)**. No long-lived access key is needed at all.
- **Conditions in the trust policy**: The `sub` claim is restricted to a **specific repository + specific branch**. Forks, other branches, and other repositories cannot AssumeRole.

Without `permissions: id-token: write`, the OIDC token itself isn't issued and the authentication step fails immediately. It's a small but easy-to-miss line, so make sure you include it.

For production use, it's a best practice to also add a `StringEquals` condition on `aud` (audience) — expected value: `sts.amazonaws.com`.

### Deployment flow (build → S3 sync → CF invalidation)

The actual deployment is just three steps.

1. **build**: `npm run build` generates the static files in `out/`
2. **S3 sync**: `aws s3 sync ./out s3://$BUCKET --delete` **uploads only the diff and deletes obsolete files**
3. **CloudFront invalidation**: `aws cloudfront create-invalidation --paths "/*"` purges the CDN cache

Adding the `--delete` option prevents the bug where renamed or removed files keep lingering on S3 forever. CloudFront cache invalidation is **free for up to 1000 paths per month**, after which it's $0.005 per path, so bundling everything into a single `/*` is the most reasonable choice for personal projects.

## Managing with IaC

### Directory layout under `infra/`

I gather all the Terraform files into an `infra/` directory and **split them by responsibility**.

```text
infra/
├── s3.tf            # Bucket for the static site and OAC
├── cloudfront.tf    # Distribution and cache policies
├── github_oidc.tf   # OIDC provider and IAM role for GitHub Actions
├── budgets.tf       # Cost alerts
├── variables.tf     # Input variables
├── outputs.tf       # Output values (bucket name, distribution ID)
└── ...
```

Splitting by resource type keeps the diff readable during PR review and avoids any single file ballooning. The region is Tokyo (`ap-northeast-1`). Note that the ACM certificate used by CloudFront must live in `us-east-1` due to the service's requirements.

### Why use Terraform for IaC

I picked Terraform this time for the following reasons:

- **Infrastructure diffs are visible in PRs**: Future-me will never remember what I clicked together in the console
- **High reproducibility**: Migrating to a different account or rebuilding after a disaster is just a single `terraform apply`
- **You notice when manual operations corrupt the configuration**: `terraform plan` surfaces "unexpected diffs," so any sneaky console change (including ones from past-me) shows up immediately
- **I wanted to use Terraform!! (the real biggest reason)**

### State management policy

Terraform's `tfstate` stores resource IDs, ARNs, and parameters in plaintext. **Leaving it on your local machine and committing it to git is a recipe for disaster**.

For this project:

- `tfstate` lives in an **S3 remote backend** (encrypted with SSE-S3)
- A **DynamoDB lock** is used to prevent concurrent applies
- The state bucket is managed in a separate account with a separate lifecycle

I'm planning a separate, deeper article specifically on state operation design.

## Summary

I built a digital business card to hand out via NFC using the following stack:

| Area             | Technology / Service                                                       | Highlights                                                  |
| ---------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Frontend         | Next.js 16 (Static Export) + React 19 + Tailwind CSS 4 + Framer Motion     | Static export, no runtime needed                            |
| AWS infrastructure | S3 + CloudFront + OAC                                                    | Fully closed public access; only reachable via CloudFront   |
| CI/CD            | GitHub Actions + OIDC                                                      | Auto-deploy on main push, keyless authentication            |
| IaC              | Terraform                                                                  | State managed safely via S3 + DynamoDB                      |
| Cost control     | AWS Budgets                                                                | $1 threshold with email notifications                       |
| NFC              | NDEF-format URI record                                                     | Just write the URL to the tag — no site-side implementation |

The key point is to keep the site's own implementation minimal and let **"the experience of opening the page the instant you tap"** be supported by AWS's CDN stack and GitHub Actions' automated deployment.
The whole thing is assembled from standard AWS building blocks.

If there's an architecture choice or implementation detail you're curious about, please let me know in the comments.
