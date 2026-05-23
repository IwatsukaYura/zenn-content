---
title: 'Google OAuthでログイン機能を実装する（Go + Gin）'
emoji: '🔐'
type: 'tech'
topics: ['go', 'oauth', 'gin', 'googleoauth', 'oidc']
published: false
---

# OAuthとは
OAuth（Open Authorization） は、**ユーザーの資格情報（IDやパスワードなど）を直接共有することなく、あるアプリケーションが別のサービスのデータにアクセスすることを許可する**ための認可フレームワークです。
つまり、あるアプリが他のサービスの特定データにアクセスしたいときに使われる **「認可」** の仕組みです。

OAuthがよく使われている例として、以下のような画面を見たことがある方も多いでしょう。
- 「Googleでログイン」
- 「GitHubでログイン」
![](https://storage.googleapis.com/zenn-user-upload/1678d96cc9b2-20250706.png)
このように、OAuthを用いれば、他サービスのアカウントを使って簡単にログインできるようになります。
:::message alert
ただし、厳密にはOAuthは「認可（Authorization）」を扱うものであり、「認証（Authentication）」ではありません。
「Googleログイン」などが実現できているのは、OAuthに加えて **OpenID Connect(OIDC)** という認証プロトコルを併用しているためです。
:::
本記事では、OAuthを用いて自分のアプリにログイン機能を実装する方法を、概念と具体的なステップの両面から解説します。

:::message
※ 記事の内容に誤りなどございましたら、コメント等でご指摘いただけますと幸いです。
:::

# OAuth認可の流れ
実装に入る前に、OAuthがどのような仕組みで動作しているのかを理解しましょう。

ここでは例として、「Googleログインを通じて、ユーザーのYouTube情報（登録チャンネルなど）にアクセスしたい」というケースを想定します。
## OAuthがなかった場合の問題点
もしOAuthが存在せず、サードパーティアプリがGoogleサービス（例：YouTube）にアクセスしたい場合、ユーザーのメールアドレスやパスワードを直接アプリに渡してGoogleにログインさせる必要があります。

これには以下のような深刻な問題があります：
- アカウント全体へのフルアクセスとなってしまう
　→ YouTubeだけでなく、GmailやGoogle Drive、スプレッドシートなど、他のサービスにもアクセスできてしまう。
- パスワード漏洩リスク
　→ アプリが悪意を持っていた場合、全データが危険にさらされる可能性あり。
- パスワードやアカウント情報が変わった場合、接続不能になる

## OAuthを利用すれば
OAuthを利用すれば、こうしたリスクを避けつつ、特定のリソースに限定した安全なアクセスが実現できます。
以下はOAuthの基本的な流れを表した図です：
![](https://storage.googleapis.com/zenn-user-upload/f1f86e5b6464-20250706.png)
1. クライアント（アプリ）は、認可サーバー（Google）に「このユーザーのYouTube情報にアクセスしたいんすけど〜」と申請する。
2. 認可サーバーは、ユーザーに「このアプリがYouTube情報にアクセスしようとしてるけど、ええんか？」と確認する。
3. ユーザーが「ええで」と答える。
4. 認可サーバーは、クライアントに **認可コード (Authorization Code)** を発行してアプリ側に戻す（リダイレクト）。
5. クライアントのサーバーは、裏側の通信で「認可コード」を認可サーバーに渡し、**access_token** と交換する。
6. クライアントはそのaccess_tokenを使って、リソースサーバー（YouTube API）に「アクセスする許可証持ってんで〜！！」と言ってデータを要求する。

このような流れなのだが、**access_token**を利用することで上述した様々な問題点を解決することができる
- アクセス範囲（スコープ）を細かく制御可能
    - 「YouTubeの閲覧のみ可」「書き込み不可」など、きめ細やかな制限ができる。
- パスワードを扱わないため、安全性が高い
- アクセストークンの有効期限や取り消しも柔軟に対応可能

# 具体的な実装
:::message
本記事ではGolangの細かい文法や、構成などの解説は行いません
:::

Googleアカウントを用いたOAuthログインを実装するには、以下のようなステップを踏みます。
1. Google Cloud ConsoleでOAuthクライアントを作成
　→ リダイレクトURIやスコープなどを設定します。
2. 認可コードの取得処理の実装
　→ クライアントからGoogleの認可エンドポイントにアクセスし、ユーザーが許可すればcodeが返されます。
3. 認可コードを使ってアクセストークンとIDトークンを取得
　→ サーバー側でcodeをGoogleのトークンエンドポイントに送信し、access_tokenおよびid_tokenを受け取ります。
4. IDトークン（JWT）を検証してユーザーを識別・ログイン
　→ id_tokenはJWT形式で、署名の検証を行うことで安全にログイン処理が可能になります。

| トークンについて | 用途 | 使用対象 |
| ---- | ---- | ---- |
| access_token | APIへのアクセス権(Youtubeなど) | リソースサーバー（Youtube API） |
| id_token | ユーザー情報の識別（名前、メール、subなど） | アプリケーション（ユーザー認証） |

それでは一つずつのステップについて解説していきます

## Google Cloud ConsoleでOAuthクライアントを作成
 OAuthログインを実現するためには、まず Google Cloud Console 上でアプリケーションを登録し、クライアントIDとクライアントシークレットを取得する必要があります。

1. Google Cloud プロジェクトの作成
    - [Google Cloud Console](https://console.cloud.google.com/)にアクセスし、ログイン
    - 左上のプロジェクトセレクターから「新しいプロジェクトを作成」
    - 任意のプロジェクト名を入力し、「作成」
2. OAuth 同意画面の設定
    - 左側メニューの「APIとサービス」→「OAuth同意画面」を開く
    - 「対象」タブの「公開ステータス」：テスト である場合はテストユーザーを追加
    - ユーザーの種類：外部 であることを確認
3. OAuth クライアントIDの作成
    - 「APIとサービス」→「認証情報」→「認証情報を作成」→「OAuth クライアントID」を選択
    - アプリケーションの種類を選択（今回は「ウェブアプリ」）
    - 任意の名前をつける
    - 承認済みのリダイレクトURIを入力（例：http://localhost:8080/auth/callback など）
    - 「作成」を押すと、クライアントIDとクライアントシークレットが発行
このクライアントID／シークレットを、アプリケーション側からGoogleのOAuth認可エンドポイントにリクエストする際に利用します。

## 認可コードの取得処理の実装

まず、Google OAuth 認可エンドポイントにリダイレクトする処理を実装します。
これにより、ユーザーがGoogleの同意画面でアクセスを許可すると、code パラメータ付きでリダイレクトURIに戻ってきます。

.envファイルの設定
```text:.env
CLIENT_ID=your_client_id
CLIENT_SECRET=your_client_secret
REDIRECT_URI=http://localhost:8080/auth/callback
STATE=your_state
SCOPE=openid email profile https://www.googleapis.com/auth/youtube.readonly
AUTH_URL=https://accounts.google.com/o/oauth2/auth
```

Ginハンドラーの実装（localhost:8080/auth/login）
```go:server.go
func (s *Server) GoogleOAuth(c *gin.Context) {
	err := godotenv.Load("./config/.env")
	if err != nil {
		log.Fatal("Error loading .env file")
	}
	// Redirect to Google OAuth URL with required parameters
	if os.Getenv("AUTH_URL") == "" || os.Getenv("CLIENT_ID") == "" ||
		os.Getenv("REDIRECT_URI") == "" || os.Getenv("SCOPE") == "" ||
		os.Getenv("STATE") == "" {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Environment variables not set"})
		return
	}
	// Construct the OAuth URL with query parameters
	scope := os.Getenv("SCOPE")
	c.Redirect(http.StatusFound, fmt.Sprintf(
		"%s?client_id=%s&redirect_uri=%s&response_type=code&scope=%s&state=%s&access_type=offline&prompt=consent",
		os.Getenv("AUTH_URL"),
		os.Getenv("CLIENT_ID"),
		os.Getenv("REDIRECT_URI"),
		url.QueryEscape(scope),
		os.Getenv("STATE"),
	))
}
```
上記のコードではGoogle OAuth認可サーバーにリダイレクトを行なっています。
リダイレクトさせるためには、先ほどの手順で生成したクライアントIDなどを用いてURLを生成します。
各パラメータの意味は以下の通り
|パラメータ|意味|
|----|----|
|response_type=code|認可コードを取得することの指定|
|client_id|[Google Cloud Console](https://console.cloud.google.com/)で発行されたクライアントID|
|redirect_uri|Googleに認可されたリダイレクトURI（コールバックURL）|
|scope|アクセスしたいGoogle APIの範囲の指定|
|state|CSRF対策のランダム文字列|
|access_type=offline|リフレッシュトークンの取得に必要|
|prompt=consent|毎回同意画面を表示させる|

## 認可コードを使ってアクセストークンとIDトークンを取得
Googleからリダイレクトされた際に返される code を使って、access_tokenとid_tokenを取得する実装を行なっていきます。

Ginハンドラーの実装（localhost:8080/auth/callback）
```go:server.go
func (s *Server) GoogleCallBack(c *gin.Context, params gen.GoogleCallBackParams) {
	// Handle the Google OAuth callback logic here
	if params.Code == "" || params.State == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Missing code or state parameter"})
		return
	}
	form := url.Values{}
	form.Add("code", params.Code)
	form.Add("client_id", os.Getenv("CLIENT_ID"))
	form.Add("client_secret", os.Getenv("CLIENT_SECRET"))
	form.Add("redirect_uri", os.Getenv("REDIRECT_URI"))
	form.Add("grant_type", "authorization_code")
	resp, err := http.PostForm("https://oauth2.googleapis.com/token", form)
	if err != nil {
		log.Printf("Error during OAuth callback: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Internal server error"})
		return
	}
	defer resp.Body.Close()
	var tokenResponse TokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&tokenResponse); err != nil {
		log.Printf("Error decoding token response: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to decode token response"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"access_token":  tokenResponse.AccessToken,
		"id_token":      tokenResponse.IDToken,
		"expires_in":    tokenResponse.ExpiresIn,
		"token_type":    tokenResponse.TokenType,
		"scope":         tokenResponse.Scope,
		"refresh_token": tokenResponse.RefreshToken,
	})
}

type TokenResponse struct {
	AccessToken  string `json:"access_token"`
	IDToken      string `json:"id_token"`
	ExpiresIn    int    `json:"expires_in"`
	TokenType    string `json:"token_type"`
	Scope        string `json:"scope"`
	RefreshToken string `json:"refresh_token"`
}
```

## id_token（JWT）を検証してユーザーを識別・ログイン
Google OAuthから取得した id_token は、JWT（JSON Web Token）形式でエンコードされており、ユーザー情報（メールアドレス、氏名など）を安全に取得するための手段として使われます。

このトークンを自前で検証することで、ユーザーが正当にGoogleを通じて認証されたかを確認できます。

JWT検証とログイン処理の実装
```go:server.go
import (
	"context"
	"log"
	"net/http"
	"os"

	"google.golang.org/api/idtoken"
)

func (s *Server) HandleLoginWithIDToken(c *gin.Context) {
	var req struct {
		IDToken string `json:"id_token"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.IDToken == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id_token is required"})
		return
	}

	// GoogleID Token Validation
	payload, err := idtoken.Validate(context.Background(), req.IDToken, os.Getenv("CLIENT_ID"))
	if err != nil {
		log.Printf("Invalid ID token: %v", err)
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid ID token"})
		return
	}

	// 正常に検証された場合、payload から情報を取得
	email, _ := payload.Claims["email"].(string)
    name, _ := payload.Claims["name"].(string)
	sub := payload.Subject // Googleアカウントの一意なID（OAuthプロバイダIDとして使用可能）

	// ユーザー登録／ログイン処理（例: DB検索 or 登録→本記事では実装対象外）

	c.JSON(http.StatusOK, gin.H{
		"message": "User authenticated",
		"name":    name,
		"email":   email,
		"user_id": sub,
	})
}
```

# まとめ

本記事では、Google OAuthを用いたログイン機能をGolang + Ginで実装する方法について、以下のステップに分けて解説しました。

1. Google Cloud ConsoleでOAuthクライアントを作成
2. 認可コード取得のためのリダイレクト処理
3. 認可コードからaccess_tokenとid_tokenを取得
4. id_tokenのJWT検証によるユーザー識別

OAuthを活用することで、ユーザーの認証情報を直接扱うことなく、安全かつ柔軟にGoogleサービスと連携できます。
今後は、取得したユーザー情報をもとに独自の認証処理を行ったり、JWTやセッション管理などを組み合わせて、本格的なログインシステムへと発展させていくことができます。

ぜひ、この記事をきっかけにOAuthや認証認可の理解を深め、実際のアプリケーションへ活かしてみてください！！