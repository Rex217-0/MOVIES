package im.moviecreator.app;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * A thin, honest shell around the Movie Creator web app.
 *
 * The phone is a remote: the heavy work runs on Server-2 (or wherever the web
 * app is deployed). This Activity shows a setup screen on first launch (where
 * is the server? what is the auth token?), stores the answer, and then loads
 * the app full-screen. It never fakes a connection: if the server is not
 * reachable, the WebView shows the real error page.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "movie_creator";
    private static final String KEY_URL = "server_url";
    private static final String KEY_TOKEN = "auth_token";

    private SharedPreferences prefs;
    private static final String APP_ORIGIN = "https://app.local";
    private String apiBase = "";
    private String apiToken = "";
    private WebView web;
    private ProgressBar bar;
    private LinearLayout setup;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0b0f1a"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        // The service worker only runs on a secure origin. Over plain HTTP on a
        // LAN it is skipped, which is correct: a cache on a non-secure origin is
        // not something we want to trust.
        CookieManager.getInstance().setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
            // The UI is served over https (app.local) while a LAN server is plain
            // http, so without this every API call is blocked as mixed content.
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public android.webkit.WebResourceResponse shouldInterceptRequest(
                    WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (u == null) return null;
                // The app is served from a fixed https origin instead of file://,
                // because a file:// page reports "Origin: null" and the server
                // cannot allow that safely. This origin is one the server knows.
                if (!APP_ORIGIN.equals(u.getScheme() + "://" + u.getHost())) return null;
                String path = u.getPath() == null ? "/" : u.getPath();
                if (path.equals("/") || path.equals("/index.html")) return injectedIndex();
                return asset(path.substring(1));
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                String host = u.getHost() == null ? "" : u.getHost();
                String base = prefs.getString(KEY_URL, "");
                Uri b = base.isEmpty() ? null : Uri.parse(base);
                if (b != null && host != null && host.equals(b.getHost())) return false;
                // External link: hand it to the system browser, do not trap it.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                bar.setVisibility(View.GONE);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView v, int p) {
                bar.setVisibility(p < 100 ? View.VISIBLE : View.GONE);
                bar.setProgress(p);
            }
        });

        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0b0f1a"));
        root.addView(bar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(buildTopBar(), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(web, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, 1f));

        setup = buildSetupScreen();
        root.addView(setup, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, 1f));

        setContentView(root);

        // The UI ships inside the APK, so show it immediately. The setup screen
        // is only for pointing it at a server, and the top bar can reopen it, so
        // a first launch is not a blank page with a form.
        String url = prefs.getString(KEY_URL, "");
        String token = prefs.getString(KEY_TOKEN, "");
        if (url == null) url = "";
        load(url, token);
        showSetup(true);
        if (url.isEmpty()) {
            Toast.makeText(this, "Walang server na naka-set. Pindutin ang Server Setup.", Toast.LENGTH_LONG).show();
        }
    }

    private int dp(float v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    private TextView label(String text, int size, int color) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(size);
        t.setTextColor(color);
        t.setPadding(0, dp(4), 0, dp(4));
        return t;
    }

    private LinearLayout buildSetupScreen() {
        ScrollView scroll = new ScrollView(this);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(dp(24), dp(40), dp(24), dp(24));
        col.setGravity(Gravity.CENTER_HORIZONTAL);

        col.addView(label("MOVIE CREATOR", 26, Color.parseColor("#e6edf3")));
        col.addView(label("Isang remote para sa movie factory.", 13, Color.parseColor("#8b98a9")));

        TextView help = label(
                "Ilagay ang address ng server kung saan naka-deploy ang app "
                        + "(ang Server-2 mo). Halimbawa: http://192.168.1.10:3000\n\n"
                        + "Kung may APP_AUTH_TOKEN ang server, ilagay rin ito — kailangan "
                        + "ito para payagan ang mga AI endpoint.", 13, Color.parseColor("#8b98a9"));
        help.setPadding(0, dp(16), 0, dp(8));
        col.addView(help);

        final EditText urlField = new EditText(this);
        urlField.setHint("http://192.168.1.10:3000");
        urlField.setTextColor(Color.parseColor("#e6edf3"));
        urlField.setHintTextColor(Color.parseColor("#5b6675"));
        urlField.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        urlField.setText(prefs.getString(KEY_URL, ""));
        col.addView(urlField);

        final EditText tokenField = new EditText(this);
        tokenField.setHint("APP_AUTH_TOKEN (opsyonal kung walang auth)");
        tokenField.setTextColor(Color.parseColor("#e6edf3"));
        tokenField.setHintTextColor(Color.parseColor("#5b6675"));
        tokenField.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        tokenField.setText(prefs.getString(KEY_TOKEN, ""));
        col.addView(tokenField);

        Button connect = new Button(this);
        connect.setText("Kumonekta");
        connect.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String url = urlField.getText().toString().trim();
                String token = tokenField.getText().toString().trim();
                if (url.isEmpty()) {
                    Toast.makeText(MainActivity.this, "Kailangan ng server address.", Toast.LENGTH_SHORT).show();
                    return;
                }
                if (!url.startsWith("http://") && !url.startsWith("https://")) {
                    url = "http://" + url;
                }
                prefs.edit().putString(KEY_URL, url).putString(KEY_TOKEN, token).apply();
                showSetup(true);
                load(url, token);
            }
        });
        col.addView(connect);

        Button clear = new Button(this);
        clear.setText("Palitan ang server");
        clear.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showSetup(false);
            }
        });
        col.addView(clear);

        scroll.addView(col);
        LinearLayout holder = new LinearLayout(this);
        holder.setOrientation(LinearLayout.VERTICAL);
        holder.addView(scroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, 1f));
        return holder;
    }

    /**
     * A bar that is always visible, with a Server Setup button. Modern phones have no
     * hardware KEYCODE_MENU, so without this the setup screen could only be
     * reached on first launch.
     */
    private View buildTopBar() {
        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setBackgroundColor(Color.parseColor("#111827"));
        top.setPadding(dp(10), dp(6), dp(10), dp(6));

        TextView title = label("Movie Creator", 15, Color.parseColor("#e5e7eb"));
        top.addView(title, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button serverSetup = new Button(this);
        serverSetup.setText("Server Setup");
        serverSetup.setAllCaps(false);
        serverSetup.setTextSize(13);
        serverSetup.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showSetup(false);
            }
        });
        top.addView(serverSetup, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        return top;
    }

    /**
     * index.html with the server address injected before the app bundle.
     *
     * The page runs from file:///android_asset, where a relative /api would
     * resolve against the APK itself, so the UI needs the absolute server URL.
     * Doing it here rather than after load guarantees the value is set before
     * React mounts and issues its first request.
     */
    /** One file out of the APK's bundled web build. */
    private android.webkit.WebResourceResponse asset(String name) {
        try (java.io.InputStream in = getAssets().open("public/" + name)) {
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            java.util.Map<String, String> headers = new java.util.HashMap<>();
            headers.put("Access-Control-Allow-Origin", APP_ORIGIN);
            return new android.webkit.WebResourceResponse(
                    mimeOf(name), null, 200, "OK", headers,
                    new java.io.ByteArrayInputStream(buf.toByteArray()));
        } catch (Exception e) {
            return new android.webkit.WebResourceResponse(
                    "text/plain", "UTF-8", 404, "Not Found", null,
                    new java.io.ByteArrayInputStream(new byte[0]));
        }
    }

    private static String mimeOf(String name) {
        if (name.endsWith(".js")) return "application/javascript";
        if (name.endsWith(".css")) return "text/css";
        if (name.endsWith(".html")) return "text/html";
        if (name.endsWith(".json") || name.endsWith(".webmanifest")) return "application/json";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
        if (name.endsWith(".svg")) return "image/svg+xml";
        if (name.endsWith(".woff2")) return "font/woff2";
        if (name.endsWith(".woff")) return "font/woff";
        if (name.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }

    private android.webkit.WebResourceResponse injectedIndex() {
        String config = "<script>window.__MOVIE_CREATOR_API_BASE__=" + jsString(apiBase) + ";"
                + "try{if(" + jsString(apiToken) + "){sessionStorage.setItem('direk_auth_token',"
                + jsString(apiToken) + ");}}catch(e){}</script>";
        try (java.io.InputStream in = getAssets().open("public/index.html")) {
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            String html = buf.toString("UTF-8");
            // Ahead of the bundle, so the global exists by the time it runs.
            html = html.replace("</head>", config + "</head>");
            java.util.Map<String, String> headers = new java.util.HashMap<>();
            headers.put("Access-Control-Allow-Origin", "*");
            headers.put("Cache-Control", "no-store");
            return new android.webkit.WebResourceResponse("text/html", "UTF-8", 200,
                    "OK", headers,
                    new java.io.ByteArrayInputStream(html.getBytes("UTF-8")));
        } catch (Exception e) {
            return null;
        }
    }

    private static String jsString(String value) {
        if (value == null) return "\"\"";
        StringBuilder out = new StringBuilder("\"");
        for (char c : value.toCharArray()) {
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                default: out.append(c);
            }
        }
        return out.append("\"").toString();
    }

    /** When connected, the setup screen is hidden; the top bar reopens it. */
    private void showSetup(boolean hide) {
        setup.setVisibility(hide ? View.GONE : View.VISIBLE);
        web.setVisibility(hide ? View.VISIBLE : View.GONE);
    }

    /**
     * Load the UI that ships inside the APK, not a blank page.
     *
     * The web build is copied into assets/public by android/build.sh, so the app
     * has a real interface with no server running. Only the data calls need the
     * server, and they are pointed at it through the injected API base.
     */
    private void load(String url, String token) {
        apiBase = url == null ? "" : url.trim();
        apiToken = token == null ? "" : token.trim();
        if (getAssets() != null) {
            try {
                getAssets().open("public/index.html").close();
                web.loadUrl(APP_ORIGIN + "/index.html");
                return;
            } catch (Exception missing) {
                // No bundled build: fall back to the server, which serves the
                // same UI, so the app still works when deployed.
            }
        }
        String target = apiBase;
        if (!apiToken.isEmpty()) {
            target = target + (target.contains("?") ? "&" : "?") + "token=" + Uri.encode(apiToken);
        }
        web.loadUrl(target);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_MENU) {
            showSetup(setup.getVisibility() == View.GONE);
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onBackPressed() {
        if (setup.getVisibility() == View.GONE && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
