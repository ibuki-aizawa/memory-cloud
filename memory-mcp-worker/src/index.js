/**
 * memory-mcp のエントリーポイント。リクエストを認証方式ごとに振り分けます（MCP の処理本体は mcp.js）。
 *
 *   1. Authorization: Bearer <MEMORY_TOKEN> または mca_...（エージェントのトークン） … OAuth も KV も通らない
 *   2. それ以外 … OAuth 2.1（@cloudflare/workers-oauth-provider）。claude.ai などの Web 版クライアント向け
 *      /mcp 以下を 1 つのリソースとして保護するので、1 回の接続で /mcp/global と /mcp/p/<slug> の両方を使えます。
 *
 * OAuth のエンドポイント
 *   /.well-known/oauth-protected-resource/mcp   リソースのメタデータ（RFC 9728）
 *   /.well-known/oauth-authorization-server     認可サーバーのメタデータ（RFC 8414）
 *   /authorize                                  同意画面と GitHub サインイン（auth.js）
 *   /oauth/token  /oauth/register               トークン発行・クライアント登録（ライブラリが処理）
 *
 * OAuth の設定（OAUTH_KV / GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET）がなければ、1 だけで動きます。
 */

import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import tokenOnlyWorker, { handleMcp, notFound, parseScope, resolveTokenIdentity, rootResponse } from './mcp.js';
import { handleAuthRoutes, isAllowedUser, oauthConfigured } from './auth.js';
import { userIdentity } from './agents.js';

const MCP_ROUTE = '/mcp';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '') return rootResponse();

    // 管理用（エージェントの発行・失効）。管理者トークンだけ
    if (url.pathname.startsWith('/admin/')) return tokenOnlyWorker.fetch(request, env);

    // Web の確認画面。OAuth を通さず、管理者トークンでログインする（dashboard.js）
    if (url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/')) return tokenOnlyWorker.fetch(request, env);

    // 1. 管理者トークン・エージェントのトークン
    if (isUnderMcpRoute(url.pathname)) {
      const identity = await resolveTokenIdentity(request, env);
      if (identity) {
        const scope = parseScope(url.pathname);
        return scope ? handleMcp(request, env, scope, identity) : notFound();
      }
    }

    // OAuth を設定していなければ、トークン認証だけで応答する
    if (!oauthConfigured(env)) return tokenOnlyWorker.fetch(request, env);

    // 2. OAuth
    return providerFor(url.origin).fetch(request, env, ctx);
  },
};

function isUnderMcpRoute(pathname) {
  return pathname === MCP_ROUTE || pathname.startsWith(`${MCP_ROUTE}/`);
}

// OAuth で認証済みのリクエスト（ctx.props は auth.js の completeAuthorization で保存した値）
const oauthMcpHandler = {
  async fetch(request, env, ctx) {
    const scope = parseScope(new URL(request.url).pathname);
    if (!scope) return notFound();
    // 許可リストから外したユーザーは、トークンの期限前でも使えなくする
    if (!isAllowedUser(env, ctx.props && ctx.props.login)) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    return handleMcp(request, env, scope, userIdentity(ctx.props.login, ctx.props.clientName));
  },
};

// リソースの URL は公開 URL（workers.dev やカスタムドメイン）から決まるので、オリジンごとに作って使い回す
const providers = new Map();

function providerFor(origin) {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider({
      apiRoute: MCP_ROUTE,
      apiHandler: oauthMcpHandler,
      defaultHandler: { fetch: (request, env) => handleAuthRoutes(request, env, origin) },
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register', // DCR（多くの MCP クライアントが使う）
      clientIdMetadataDocumentEnabled: true, // CIMD（新しい MCP クライアント向け。global_fetch_strictly_public が必要）
      resourceMetadata: {
        resource: `${origin}${MCP_ROUTE}`,
        authorization_servers: [origin],
        bearer_methods_supported: ['header'],
        resource_name: 'memory-mcp',
      },
      accessTokenTTL: 60 * 60, // 1 時間
      refreshTokenIdleTTL: 60 * 60 * 24 * 60, // 60 日使わなければ再ログイン
    });
    providers.set(origin, provider);
  }
  return provider;
}
