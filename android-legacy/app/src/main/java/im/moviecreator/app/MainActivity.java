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
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }

        web.setWebViewClient(new WebViewClient() {
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
        root.addView(web, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, 1f));

        setup = buildSetupScreen();
        root.addView(setup, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, 1f));

        setContentView(root);

        String url = prefs.getString(KEY_URL, "");
        if (url == null || url.isEmpty()) {
            showSetup(false);
        } else {
            showSetup(true);
            load(url, prefs.getString(KEY_TOKEN, ""));
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

    /** When connected, the setup screen is hidden; it is one tap away via the menu. */
    private void showSetup(boolean hide) {
        setup.setVisibility(hide ? View.GONE : View.VISIBLE);
        web.setVisibility(hide ? View.VISIBLE : View.GONE);
    }

    private void load(String url, String token) {
        String target = url;
        if (token != null && !token.isEmpty()) {
            // The app reads ?token= once and keeps it in sessionStorage, so the
            // token does not stay in the address bar afterwards.
            target = url + (url.contains("?") ? "&" : "?") + "token=" + Uri.encode(token);
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
