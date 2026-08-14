package io.qzz.superstar1014.mynotes;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.DialogInterface;
import android.content.pm.ApplicationInfo;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.widget.AdapterView;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.GridView;
import android.widget.HorizontalScrollView;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

import javax.crypto.SecretKey;

public final class MainActivity extends Activity {
  private static final long AUTO_SAVE_DELAY_MS = 10_000L;
  private static final String LOCATION_ALL = "all";
  private static final String LOCATION_UNFILED = "unfiled";
  private static final String LOCATION_TRASH = "trash";
  private static final String LOCATION_FOLDER_PREFIX = "folder:";

  private final Handler handler = new Handler(Looper.getMainLooper());
  private final ExecutorService executor = Executors.newSingleThreadExecutor();
  private final List<Models.NoteDocument> notes = new ArrayList<>();
  private final List<Models.NoteDocument> trash = new ArrayList<>();
  private final List<Models.FolderDocument> folders = new ArrayList<>();
  private final List<Models.NoteDocument> visibleNotes = new ArrayList<>();

  private NotesApiClient api;
  private Models.User user;
  private SecretKey dataKey;
  private Models.ProtectionKeyring protectionKeyring;
  private SecretKey protectionKey;
  private Models.NoteDocument selectedNote;
  private String location = LOCATION_ALL;
  private String searchQuery = "";
  private int displayMode = 0;
  private boolean editorVisible;
  private boolean bindingEditor;
  private boolean dirty;
  private boolean saving;
  private boolean demoMode;

  private EditText titleField;
  private EditText bodyField;
  private TextView saveStatus;
  private FrameLayout homeListContainer;
  private TextView homeCount;
  private Runnable pendingAutoSave;
  private OnBackInvokedCallback backCallback;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getWindow().setNavigationBarContrastEnforced(false);
    demoMode = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0
      && getIntent().getBooleanExtra("demo", false);
    backCallback = this::handleBackNavigation;
    getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
      OnBackInvokedDispatcher.PRIORITY_DEFAULT,
      backCallback
    );
    api = new NotesApiClient(this, demoMode ? "http://127.0.0.1:9/" : NotesApiClient.PRODUCTION_BASE_URL);
    if (demoMode) loadDemoData();
    else restoreSession();
  }

  private void loadDemoData() {
    try {
      user = new Models.User("demo", false);
      dataKey = CryptoEngine.importDataKey(
        "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
      );
      folders.clear();
      folders.add(new Models.FolderDocument(
        demoFolderEnvelope("folder_demo_linux"),
        "Linux"
      ));
      folders.add(new Models.FolderDocument(
        demoFolderEnvelope("folder_demo_account"),
        "账号信息"
      ));
      notes.clear();
      notes.add(demoNote(
        "note_demo_android",
        "folder_demo_linux",
        "Android 开发记录",
        "API、AES-GCM 加密兼容和移动端列表布局已经完成。",
        false
      ));
      notes.add(demoNote(
        "note_demo_search",
        null,
        "搜索与文件夹",
        "可以搜索标题和正文，并按文件夹筛选笔记。",
        false
      ));
      notes.add(demoNote(
        "note_demo_protected",
        "folder_demo_account",
        "账号安全约定",
        "",
        true
      ));
      trash.clear();
      Models.NoteDocument deleted = demoNote(
        "note_demo_deleted",
        null,
        "已删除的示例笔记",
        "可以从回收站恢复。",
        false
      );
      deleted.envelope.deletedAt = "2026-08-14T06:00:00Z";
      trash.add(deleted);
      renderHome();
    } catch (Exception error) {
      showError(error);
    }
  }

  private Models.FolderEnvelope demoFolderEnvelope(String id) {
    return new Models.FolderEnvelope(
      id,
      1,
      1,
      "demo_ciphertext",
      "demo_nonce",
      "2026-08-14T06:00:00Z",
      "2026-08-14T06:00:00Z"
    );
  }

  private Models.NoteDocument demoNote(
    String id,
    String folderId,
    String title,
    String body,
    boolean locked
  ) {
    Models.ProtectedBody protectedBody = locked
      ? new Models.ProtectedBody(1, "demo_ciphertext", "demo_nonce")
      : null;
    Models.NoteEnvelope envelope = new Models.NoteEnvelope(
      id,
      folderId,
      1,
      1,
      "demo_ciphertext",
      "demo_nonce",
      "2026-08-14T06:00:00Z",
      "2026-08-14T06:00:00Z",
      null,
      locked
    );
    return new Models.NoteDocument(
      envelope,
      new Models.NoteContent(title, body, protectedBody)
    );
  }

  @Override
  protected void onDestroy() {
    if (backCallback != null) {
      getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
    }
    handler.removeCallbacksAndMessages(null);
    executor.shutdownNow();
    super.onDestroy();
  }

  private void handleBackNavigation() {
    if (editorVisible) {
      closeEditor();
    } else {
      finish();
    }
  }

  @Override
  public boolean onKeyShortcut(int keyCode, KeyEvent event) {
    if (keyCode == KeyEvent.KEYCODE_S && event.isCtrlPressed() && editorVisible) {
      saveSelected(null);
      return true;
    }
    return super.onKeyShortcut(keyCode, event);
  }

  private void restoreSession() {
    showLoading("正在恢复登录状态…");
    runAsync(api::restoreSession, session -> {
      if (!session.authenticated) {
        showLogin();
        return;
      }
      user = session.user;
      loadAllData();
    });
  }

  private void loadAllData() {
    showLoading("正在解密笔记…");
    runAsync(() -> {
      SecretKey key = CryptoEngine.importDataKey(api.workspaceKey());
      Models.ProtectionKeyring keyring = api.protectionKeyring();
      List<Models.FolderDocument> loadedFolders = new ArrayList<>();
      for (Models.FolderEnvelope envelope : api.listFolders()) {
        loadedFolders.add(new Models.FolderDocument(envelope, CryptoEngine.decryptFolder(key, envelope)));
      }
      List<Models.NoteDocument> loadedNotes = decryptNotes(key, api.listNotes(false));
      List<Models.NoteDocument> loadedTrash = decryptNotes(key, api.listNotes(true));
      return new LoadedData(key, keyring, loadedFolders, loadedNotes, loadedTrash);
    }, loaded -> {
      dataKey = loaded.dataKey;
      protectionKeyring = loaded.keyring;
      folders.clear();
      folders.addAll(loaded.folders);
      notes.clear();
      notes.addAll(loaded.notes);
      trash.clear();
      trash.addAll(loaded.trash);
      renderHome();
    });
  }

  private List<Models.NoteDocument> decryptNotes(
    SecretKey key,
    List<Models.NoteEnvelope> envelopes
  ) throws Exception {
    List<Models.NoteDocument> result = new ArrayList<>();
    for (Models.NoteEnvelope envelope : envelopes) {
      result.add(new Models.NoteDocument(envelope, CryptoEngine.decryptNote(key, envelope)));
    }
    result.sort(Comparator.comparing(
      document -> document.envelope.updatedAt == null ? "" : document.envelope.updatedAt,
      Comparator.reverseOrder()
    ));
    return result;
  }

  private void showLogin() {
    editorVisible = false;
    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(getColor(R.color.background));
    ScrollView scroll = new ScrollView(this);
    scroll.setFillViewport(true);
    scroll.setClipToPadding(false);

    LinearLayout form = verticalLayout(0);
    form.setPadding(dp(24), dp(36), dp(24), dp(36));

    LinearLayout brand = horizontalLayout(Gravity.CENTER_VERTICAL);
    ImageView logo = iconView(R.drawable.ic_note, R.color.on_brand, "My Notes", 28);
    logo.setBackground(roundedBackground(R.color.brand_primary, 16));
    logo.setPadding(dp(12), dp(12), dp(12), dp(12));
    brand.addView(logo, new LinearLayout.LayoutParams(dp(52), dp(52)));
    TextView wordmark = text("My Notes", 18, R.color.text_primary);
    wordmark.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    brand.addView(wordmark, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      dp(52)
    ));
    ((LinearLayout.LayoutParams) wordmark.getLayoutParams()).setMarginStart(dp(12));
    form.addView(brand, matchWrap(0, 0, 0, 48));

    TextView eyebrow = text("你的私人笔记空间", 13, R.color.brand_primary_dark);
    eyebrow.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    form.addView(eyebrow, matchWrap(2, 0, 0, 8));

    TextView title = text("欢迎回来", 34, R.color.text_primary);
    title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    form.addView(title, matchWrap(0, 0, 0, 8));

    TextView subtitle = text(getString(R.string.login_description), 15, R.color.text_secondary);
    subtitle.setLineSpacing(0, 1.25f);
    form.addView(subtitle, matchWrap(0, 0, 0, 28));

    LinearLayout card = verticalLayout(0);
    card.setPadding(dp(20), dp(22), dp(20), dp(20));
    card.setBackground(roundedStrokeBackground(R.color.surface, R.color.divider, 24, 1));

    TextView usernameLabel = text(getString(R.string.username), 14, R.color.text_primary);
    usernameLabel.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    card.addView(usernameLabel, matchWrap(2, 0, 0, 8));
    EditText usernameField = editText(getString(R.string.username), false);
    usernameField.setSingleLine(true);
    usernameField.setInputType(InputType.TYPE_CLASS_TEXT);
    card.addView(usernameField, matchHeight(dp(56), 0, 0, 0, 20));

    TextView passwordLabel = text(getString(R.string.password), 14, R.color.text_primary);
    passwordLabel.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    card.addView(passwordLabel, matchWrap(2, 0, 0, 8));
    EditText passwordField = editText(getString(R.string.password), true);
    passwordField.setSingleLine(true);
    card.addView(passwordField, matchHeight(dp(56), 0, 0, 0, 6));

    CheckBox showPassword = new CheckBox(this);
    showPassword.setText(R.string.show_password);
    showPassword.setTextColor(getColor(R.color.text_secondary));
    showPassword.setMinHeight(dp(48));
    showPassword.setOnCheckedChangeListener((button, checked) -> {
      passwordField.setInputType(
        InputType.TYPE_CLASS_TEXT
          | (checked ? InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD : InputType.TYPE_TEXT_VARIATION_PASSWORD)
      );
      passwordField.setSelection(passwordField.length());
    });
    showPassword.setButtonTintList(ColorStateList.valueOf(getColor(R.color.brand_primary)));
    card.addView(showPassword, matchHeight(dp(48), 0, 0, 0, 16));

    IconTextButton loginButton = primaryIconButton(getString(R.string.login), R.drawable.ic_login);
    loginButton.setOnClickListener(view -> {
      String username = usernameField.getText().toString().trim();
      String password = passwordField.getText().toString();
      if (username.isEmpty() || password.isEmpty()) {
        toast("请输入账号和密码。");
        return;
      }
      loginButton.setEnabled(false);
      loginButton.setText("正在登录…");
      runAsync(() -> api.login(username, password), loggedInUser -> {
        user = loggedInUser;
        loadAllData();
      }, error -> {
        loginButton.setEnabled(true);
        loginButton.setText(getString(R.string.login));
        showError(error);
      });
    });
    passwordField.setOnEditorActionListener((view, actionId, event) -> {
      loginButton.performClick();
      return true;
    });
    card.addView(loginButton, matchHeight(dp(56), 0, 0, 0, 0));
    form.addView(card, matchWrap(0, 0, 0, 20));

    LinearLayout security = horizontalLayout(Gravity.CENTER_VERTICAL);
    ImageView lock = iconView(R.drawable.ic_lock, R.color.text_secondary, "端到端加密", 18);
    security.addView(lock, new LinearLayout.LayoutParams(dp(32), dp(32)));
    TextView securityText = text("笔记内容加密后同步，服务器不保存明文", 13, R.color.text_secondary);
    securityText.setLineSpacing(0, 1.2f);
    security.addView(securityText, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
    form.addView(security, matchWrap(4, 0, 4, 0));

    scroll.addView(form, new ScrollView.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ));
    root.addView(scroll, frameMatch());
    setContentView(applySystemInsets(root));
  }

  private void renderHome() {
    editorVisible = false;
    selectedNote = null;
    protectionKey = null;
    handler.removeCallbacksAndMessages(null);
    dirty = false;
    saving = false;
    filterVisibleNotes();
    boolean landscape = getResources().getConfiguration().orientation
      == android.content.res.Configuration.ORIENTATION_LANDSCAPE;
    boolean largeText = getResources().getConfiguration().fontScale >= 1.2f;
    int summaryHeight = landscape ? (largeText ? 64 : 52) : (largeText ? 72 : 60);

    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(getColor(R.color.background));
    LinearLayout column = verticalLayout(0);
    root.addView(column, frameMatch());

    LinearLayout topBar = horizontalLayout(Gravity.CENTER_VERTICAL);
    topBar.setPadding(dp(18), landscape ? dp(6) : dp(12), dp(14), landscape ? dp(4) : dp(8));
    ImageView brandIcon = iconView(R.drawable.ic_note, R.color.on_brand, "My Notes", 22);
    brandIcon.setBackground(roundedBackground(R.color.brand_primary, 14));
    brandIcon.setPadding(dp(10), dp(10), dp(10), dp(10));
    topBar.addView(brandIcon, new LinearLayout.LayoutParams(dp(44), dp(44)));

    LinearLayout heading = verticalLayout(0);
    TextView appTitle = text("My Notes", 21, R.color.text_primary);
    appTitle.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    heading.addView(appTitle, matchWrap(0, 0, 0, 0));
    TextView account = text(user == null ? "" : user.username, 12, R.color.text_secondary);
    heading.addView(account, matchWrap(0, 0, 0, 0));
    LinearLayout.LayoutParams headingParams = new LinearLayout.LayoutParams(0, dp(52), 1);
    headingParams.setMarginStart(dp(12));
    topBar.addView(heading, headingParams);

    ImageButton refresh = iconButton(R.drawable.ic_refresh, "刷新笔记", false);
    refresh.setOnClickListener(view -> loadAllData());
    topBar.addView(refresh, new LinearLayout.LayoutParams(dp(48), dp(48)));
    ImageButton locationButton = iconButton(R.drawable.ic_folder, "文件夹和账户菜单", true);
    locationButton.setOnClickListener(this::showLocationMenu);
    LinearLayout.LayoutParams locationParams = new LinearLayout.LayoutParams(dp(48), dp(48));
    locationParams.setMarginStart(dp(8));
    topBar.addView(locationButton, locationParams);
    if (landscape && !LOCATION_TRASH.equals(location)) {
      ImageButton newNote = iconButton(R.drawable.ic_add, getString(R.string.new_note), false);
      newNote.setImageTintList(ColorStateList.valueOf(getColor(R.color.on_brand)));
      newNote.setBackground(rippleBackground(R.color.brand_primary, 16));
      newNote.setOnClickListener(view -> createNote());
      LinearLayout.LayoutParams addParams = new LinearLayout.LayoutParams(dp(48), dp(48));
      addParams.setMarginStart(dp(8));
      topBar.addView(newNote, addParams);
    }
    column.addView(topBar, matchHeight(dp(landscape ? 60 : 72), 0, 0, 0, 0));

    EditText search = editText(getString(R.string.search_notes), false);
    search.setSingleLine(true);
    search.setText(searchQuery);
    Drawable searchIcon = getDrawable(R.drawable.ic_search);
    searchIcon.setTint(getColor(R.color.text_secondary));
    search.setCompoundDrawablesWithIntrinsicBounds(searchIcon, null, null, null);
    search.setCompoundDrawablePadding(dp(10));
    search.setBackground(roundedStrokeBackground(R.color.surface, R.color.divider, 18, 1));
    search.setPadding(dp(16), dp(8), dp(16), dp(8));
    search.addTextChangedListener(new SimpleTextWatcher() {
      @Override public void afterTextChanged(Editable editable) {
        searchQuery = editable.toString();
        renderHomeListOnly();
      }
    });
    LinearLayout.LayoutParams searchParams = matchHeight(
      dp(landscape ? 48 : 56),
      18,
      landscape ? 0 : 4,
      18,
      landscape ? 6 : 12
    );
    column.addView(search, searchParams);

    HorizontalScrollView folderScroll = new HorizontalScrollView(this);
    folderScroll.setHorizontalScrollBarEnabled(false);
    folderScroll.setClipToPadding(false);
    folderScroll.setPadding(dp(14), 0, dp(14), 0);
    LinearLayout folderRail = horizontalLayout(Gravity.CENTER_VERTICAL);
    addFolderChip(folderRail, "全部", LOCATION_ALL, R.drawable.ic_note);
    addFolderChip(folderRail, "未分类", LOCATION_UNFILED, R.drawable.ic_unfiled);
    for (Models.FolderDocument folder : folders) {
      addFolderChip(
        folderRail,
        folder.name,
        LOCATION_FOLDER_PREFIX + folder.envelope.id,
        R.drawable.ic_folder
      );
    }
    addFolderChip(folderRail, "回收站", LOCATION_TRASH, R.drawable.ic_trash);
    folderScroll.addView(folderRail, new HorizontalScrollView.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      dp(landscape ? 42 : 48)
    ));
    column.addView(folderScroll, matchHeight(dp(landscape ? 42 : 48), 0, 0, 0, landscape ? 4 : 8));

    LinearLayout summary = horizontalLayout(Gravity.CENTER_VERTICAL);
    summary.setPadding(dp(20), 0, dp(14), 0);
    LinearLayout summaryText = verticalLayout(0);
    TextView locationTitle = text(locationTitle(), 20, R.color.text_primary);
    locationTitle.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    summaryText.addView(locationTitle, matchWrap(0, 0, 0, 0));
    int count = visibleNotes.size();
    homeCount = text(
      getResources().getQuantityString(R.plurals.note_count, count, count),
      13,
      R.color.text_secondary
    );
    summaryText.addView(homeCount, matchWrap(0, 0, 0, 0));
    summary.addView(summaryText, new LinearLayout.LayoutParams(0, dp(summaryHeight), 1));
    ImageButton mode = iconButton(modeIcon(), "切换笔记列表显示方式，当前" + modeTitle(), true);
    mode.setOnClickListener(this::showModeMenu);
    summary.addView(mode, new LinearLayout.LayoutParams(dp(48), dp(48)));
    column.addView(summary, matchHeight(dp(summaryHeight), 0, 0, 0, 0));

    homeListContainer = new FrameLayout(this);
    homeListContainer.setId(View.generateViewId());
    column.addView(homeListContainer, new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      0,
      1
    ));
    populateListContainer(homeListContainer);

    if (!LOCATION_TRASH.equals(location)) {
      if (!landscape) {
        IconTextButton newNote = primaryIconButton(getString(R.string.new_note), R.drawable.ic_add);
        newNote.setOnClickListener(view -> createNote());
        column.addView(newNote, matchHeight(dp(56), 18, 10, 18, 16));
      }
    }
    setContentView(applySystemInsets(root));
  }

  private void addFolderChip(LinearLayout rail, String label, String value, int iconRes) {
    Button chip = chipButton(label, iconRes, value.equals(location));
    chip.setOnClickListener(view -> {
      location = value;
      searchQuery = "";
      renderHome();
    });
    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      dp(40)
    );
    params.setMargins(dp(4), dp(4), dp(4), dp(4));
    rail.addView(chip, params);
  }

  private void renderHomeListOnly() {
    if (homeListContainer == null) return;
    filterVisibleNotes();
    homeListContainer.removeAllViews();
    populateListContainer(homeListContainer);
    if (homeCount != null) {
      int count = visibleNotes.size();
      homeCount.setText(getResources().getQuantityString(R.plurals.note_count, count, count));
    }
  }

  private void filterVisibleNotes() {
    visibleNotes.clear();
    List<Models.NoteDocument> source = LOCATION_TRASH.equals(location) ? trash : notes;
    for (Models.NoteDocument note : source) {
      boolean matchesLocation;
      if (LOCATION_ALL.equals(location) || LOCATION_TRASH.equals(location)) {
        matchesLocation = true;
      } else if (LOCATION_UNFILED.equals(location)) {
        matchesLocation = note.envelope.folderId == null;
      } else {
        matchesLocation = location.equals(LOCATION_FOLDER_PREFIX + note.envelope.folderId);
      }
      if (matchesLocation && note.matches(searchQuery)) visibleNotes.add(note);
    }
  }

  private void populateListContainer(FrameLayout container) {
    if (visibleNotes.isEmpty()) {
      LinearLayout empty = verticalLayout(0);
      empty.setGravity(Gravity.CENTER);
      int emptyIcon = LOCATION_TRASH.equals(location) ? R.drawable.ic_trash : R.drawable.ic_note;
      ImageView icon = iconView(emptyIcon, R.color.brand_primary_dark, "空状态", 30);
      icon.setPadding(dp(18), dp(18), dp(18), dp(18));
      icon.setBackground(roundedBackground(R.color.surface_tonal, 28));
      empty.addView(icon, new LinearLayout.LayoutParams(dp(72), dp(72)));
      boolean searchEmpty = !searchQuery.trim().isEmpty();
      TextView label = text(
        searchEmpty ? "没有找到相关笔记" : LOCATION_TRASH.equals(location) ? "回收站是空的" : "从第一条笔记开始",
        18,
        R.color.text_primary
      );
      label.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
      label.setGravity(Gravity.CENTER);
      empty.addView(label, matchWrap(24, 18, 24, 6));
      TextView detail = text(
        searchEmpty ? "换一个关键词，或清空搜索后再试" : LOCATION_TRASH.equals(location)
          ? "删除的笔记会在这里保留，方便恢复"
          : "记录灵感、资料和重要信息",
        14,
        R.color.text_secondary
      );
      detail.setGravity(Gravity.CENTER);
      empty.addView(detail, matchWrap(32, 0, 32, 0));
      container.addView(empty, frameMatch());
      return;
    }

    NotesAdapter adapter = new NotesAdapter();
    AdapterView<?> list;
    if (displayMode == 1) {
      GridView grid = new GridView(this);
      grid.setNumColumns(getResources().getConfiguration().smallestScreenWidthDp >= 600 ? 3 : 2);
      grid.setHorizontalSpacing(dp(4));
      grid.setVerticalSpacing(dp(4));
      grid.setPadding(dp(12), dp(4), dp(12), dp(12));
      grid.setClipToPadding(false);
      grid.setAdapter(adapter);
      list = grid;
    } else {
      ListView rows = new ListView(this);
      rows.setDivider(null);
      rows.setDividerHeight(0);
      rows.setPadding(dp(12), 0, dp(12), dp(8));
      rows.setClipToPadding(false);
      rows.setAdapter(adapter);
      list = rows;
    }
    list.setOnItemClickListener((parent, view, position, id) -> {
      selectedNote = visibleNotes.get(position);
      renderEditor();
    });
    container.addView((View) list, frameMatch());
  }

  private void showLocationMenu(View anchor) {
    PopupMenu menu = new PopupMenu(this, anchor);
    menu.getMenu().add(0, 1, 0, "全部笔记（" + notes.size() + "）").setIcon(R.drawable.ic_note);
    int unfiled = 0;
    for (Models.NoteDocument note : notes) if (note.envelope.folderId == null) unfiled++;
    menu.getMenu().add(0, 2, 1, "未分类（" + unfiled + "）").setIcon(R.drawable.ic_unfiled);
    int nextId = 100;
    for (Models.FolderDocument folder : folders) {
      int count = 0;
      for (Models.NoteDocument note : notes) {
        if (folder.envelope.id.equals(note.envelope.folderId)) count++;
      }
      menu.getMenu().add(1, nextId++, nextId, folder.name + "（" + count + "）").setIcon(R.drawable.ic_folder);
    }
    menu.getMenu().add(2, 3, 1_000, "新建文件夹").setIcon(R.drawable.ic_add);
    if (!folders.isEmpty()) menu.getMenu().add(2, 6, 1_001, "管理文件夹").setIcon(R.drawable.ic_folder);
    menu.getMenu().add(2, 4, 1_002, "回收站（" + trash.size() + "）").setIcon(R.drawable.ic_trash);
    menu.getMenu().add(3, 5, 2_000, "退出登录").setIcon(R.drawable.ic_logout);
    menu.setOnMenuItemClickListener(item -> {
      if (item.getItemId() == 1) location = LOCATION_ALL;
      else if (item.getItemId() == 2) location = LOCATION_UNFILED;
      else if (item.getItemId() == 3) {
        createFolder();
        return true;
      } else if (item.getItemId() == 4) location = LOCATION_TRASH;
      else if (item.getItemId() == 6) {
        manageFolders();
        return true;
      }
      else if (item.getItemId() == 5) {
        logout();
        return true;
      } else if (item.getGroupId() == 1) {
        int index = item.getItemId() - 100;
        if (index >= 0 && index < folders.size()) {
          location = LOCATION_FOLDER_PREFIX + folders.get(index).envelope.id;
        }
      }
      searchQuery = "";
      renderHome();
      return true;
    });
    menu.show();
  }

  private void showModeMenu(View anchor) {
    PopupMenu menu = new PopupMenu(this, anchor);
    menu.getMenu().add(0, 10, 0, "详细列表").setIcon(R.drawable.ic_list).setCheckable(true).setChecked(displayMode == 0);
    menu.getMenu().add(0, 11, 1, "图文卡片").setIcon(R.drawable.ic_grid).setCheckable(true).setChecked(displayMode == 1);
    menu.getMenu().add(0, 12, 2, "标题列表").setIcon(R.drawable.ic_title).setCheckable(true).setChecked(displayMode == 2);
    menu.setOnMenuItemClickListener(item -> {
      displayMode = item.getItemId() - 10;
      renderHome();
      return true;
    });
    menu.show();
  }

  private void createNote() {
    String id = UUID.randomUUID().toString();
    String targetFolder = location.startsWith(LOCATION_FOLDER_PREFIX)
      ? location.substring(LOCATION_FOLDER_PREFIX.length())
      : null;
    if (demoMode) {
      Models.NoteDocument document = demoNote(id, targetFolder, "无标题笔记", "", false);
      notes.add(0, document);
      selectedNote = document;
      renderEditor();
      titleField.selectAll();
      return;
    }
    showLoading("正在创建笔记…");
    runAsync(() -> {
      Models.NoteContent content = new Models.NoteContent("无标题笔记", "", null);
      Models.NoteEnvelope envelope = api.createNote(CryptoEngine.encryptNote(dataKey, id, content));
      if (targetFolder != null) {
        JSONObject moved = api.moveNote(envelope.id, targetFolder, envelope.revision);
        applyMutation(envelope, moved);
      }
      return new Models.NoteDocument(envelope, content);
    }, document -> {
      notes.add(0, document);
      selectedNote = document;
      renderEditor();
      titleField.selectAll();
      titleField.requestFocus();
      keyboard(titleField, true);
    });
  }

  private void renderEditor() {
    if (selectedNote == null) {
      renderHome();
      return;
    }
    editorVisible = true;
    bindingEditor = true;
    handler.removeCallbacksAndMessages(null);

    LinearLayout root = verticalLayout(0);
    root.setBackgroundColor(getColor(R.color.background));

    LinearLayout topBar = horizontalLayout(Gravity.CENTER_VERTICAL);
    topBar.setPadding(dp(10), dp(8), dp(10), dp(8));
    ImageButton back = iconButton(R.drawable.ic_arrow_back, "返回笔记列表", false);
    back.setOnClickListener(view -> closeEditor());
    topBar.addView(back, new LinearLayout.LayoutParams(dp(48), dp(48)));

    LinearLayout context = verticalLayout(0);
    TextView folder = text(folderName(selectedNote.envelope.folderId), 14, R.color.text_primary);
    folder.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    context.addView(folder, matchWrap(0, 0, 0, 0));
    saveStatus = text(saveStatusText(), 12, dirty ? R.color.warning : R.color.text_secondary);
    context.addView(saveStatus, matchWrap(0, 0, 0, 0));
    LinearLayout.LayoutParams contextParams = new LinearLayout.LayoutParams(0, dp(52), 1);
    contextParams.setMarginStart(dp(8));
    topBar.addView(context, contextParams);

    if (!LOCATION_TRASH.equals(location)) {
      ImageButton save = iconButton(R.drawable.ic_save, "保存笔记", true);
      save.setOnClickListener(view -> saveSelected(null));
      topBar.addView(save, new LinearLayout.LayoutParams(dp(48), dp(48)));
    }
    ImageButton more = iconButton(R.drawable.ic_more, "更多笔记操作", false);
    more.setOnClickListener(this::showEditorActions);
    LinearLayout.LayoutParams moreParams = new LinearLayout.LayoutParams(dp(48), dp(48));
    moreParams.setMarginStart(dp(8));
    topBar.addView(more, moreParams);
    root.addView(topBar, matchHeight(dp(68), 0, 0, 0, 0));

    LinearLayout paper = verticalLayout(0);
    paper.setBackground(roundedStrokeBackground(R.color.surface, R.color.divider, 24, 1));

    LinearLayout noteMeta = horizontalLayout(Gravity.CENTER_VERTICAL);
    noteMeta.setPadding(dp(20), dp(12), dp(20), 0);
    ImageView noteIcon = iconView(
      selectedNote.envelope.locked ? R.drawable.ic_lock : R.drawable.ic_note,
      R.color.brand_primary_dark,
      selectedNote.envelope.locked ? "受保护笔记" : "普通笔记",
      16
    );
    noteMeta.addView(noteIcon, new LinearLayout.LayoutParams(dp(28), dp(28)));
    TextView date = text(selectedNote.envelope.displayDate(), 12, R.color.text_secondary);
    noteMeta.addView(date, new LinearLayout.LayoutParams(0, dp(32), 1));
    paper.addView(noteMeta, matchHeight(dp(44), 0, 0, 0, 0));

    titleField = editText("无标题笔记", false);
    titleField.setText(selectedNote.content.title);
    titleField.setTextSize(27);
    titleField.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    titleField.setSingleLine(false);
    titleField.setMaxLines(3);
    titleField.setPadding(dp(20), dp(4), dp(20), dp(10));
    titleField.setBackgroundColor(Color.TRANSPARENT);
    titleField.setEnabled(!LOCATION_TRASH.equals(location));
    titleField.addTextChangedListener(editorWatcher(true));
    paper.addView(titleField, matchWrap(0, 0, 0, 0));

    View divider = new View(this);
    divider.setBackgroundColor(getColor(R.color.divider));
    paper.addView(divider, matchHeight(dp(1), 20, 0, 20, 0));

    if (selectedNote.envelope.locked && !selectedNote.unlocked) {
      LinearLayout lockPanel = verticalLayout(0);
      lockPanel.setGravity(Gravity.CENTER);
      lockPanel.setPadding(dp(28), dp(36), dp(28), dp(36));
      ImageView lock = iconView(R.drawable.ic_lock, R.color.brand_primary_dark, "正文已锁定", 32);
      lock.setPadding(dp(20), dp(20), dp(20), dp(20));
      lock.setBackground(roundedBackground(R.color.surface_tonal, 34));
      lockPanel.addView(lock, new LinearLayout.LayoutParams(dp(84), dp(84)));
      TextView lockTitle = text("正文已受保护", 20, R.color.text_primary);
      lockTitle.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
      lockTitle.setGravity(Gravity.CENTER);
      lockPanel.addView(lockTitle, matchWrap(0, 22, 0, 8));
      TextView description = text("输入独立保护密码后，才能在这台设备上查看正文。", 15, R.color.text_secondary);
      description.setGravity(Gravity.CENTER);
      description.setLineSpacing(0, 1.25f);
      lockPanel.addView(description, matchWrap(0, 0, 0, 24));
      IconTextButton unlock = primaryIconButton(getString(R.string.unlock), R.drawable.ic_lock);
      unlock.setOnClickListener(view -> unlockSelected(null));
      lockPanel.addView(unlock, new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        dp(56)
      ));
      paper.addView(lockPanel, new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        0,
        1
      ));
    } else {
      bodyField = editText("开始记录…", false);
      bodyField.setGravity(Gravity.TOP | Gravity.START);
      bodyField.setTextSize(17.5f);
      bodyField.setLineSpacing(dp(3), 1.18f);
      bodyField.setText(selectedNote.content.content);
      bodyField.setInputType(
        InputType.TYPE_CLASS_TEXT
          | InputType.TYPE_TEXT_FLAG_MULTI_LINE
          | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
      );
      bodyField.setPadding(dp(20), dp(14), dp(20), dp(20));
      bodyField.setBackgroundColor(Color.TRANSPARENT);
      bodyField.setEnabled(!LOCATION_TRASH.equals(location));
      bodyField.addTextChangedListener(editorWatcher(false));
      paper.addView(bodyField, new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        0,
        1
      ));
    }

    LinearLayout.LayoutParams paperParams = new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      0,
      1
    );
    paperParams.setMargins(dp(14), dp(4), dp(14), dp(14));
    root.addView(paper, paperParams);

    setContentView(applySystemInsets(root));
    bindingEditor = false;
  }

  private TextWatcher editorWatcher(boolean title) {
    return new SimpleTextWatcher() {
      @Override public void afterTextChanged(Editable editable) {
        if (bindingEditor || selectedNote == null) return;
        if (title) selectedNote.content.title = editable.toString();
        else selectedNote.content.content = editable.toString();
        markDirty();
      }
    };
  }

  private void markDirty() {
    dirty = true;
    if (saveStatus != null) {
      saveStatus.setText("有未保存更改");
      saveStatus.setTextColor(getColor(R.color.warning));
    }
    if (pendingAutoSave != null) handler.removeCallbacks(pendingAutoSave);
    pendingAutoSave = () -> saveSelected(null);
    handler.postDelayed(pendingAutoSave, AUTO_SAVE_DELAY_MS);
  }

  private void saveSelected(Runnable afterSave) {
    if (selectedNote == null || LOCATION_TRASH.equals(location)) {
      if (afterSave != null) afterSave.run();
      return;
    }
    if (!dirty || saving) {
      if (afterSave != null && !saving) afterSave.run();
      return;
    }
    if (demoMode) {
      saving = true;
      if (saveStatus != null) saveStatus.setText("正在保存…");
      handler.postDelayed(() -> {
        saving = false;
        dirty = false;
        if (selectedNote != null) selectedNote.envelope.revision += 1;
        if (saveStatus != null) {
          saveStatus.setText("已保存");
          saveStatus.setTextColor(getColor(R.color.brand_primary_dark));
        }
        if (afterSave != null) afterSave.run();
      }, 200);
      return;
    }
    handler.removeCallbacksAndMessages(null);
    Models.NoteDocument note = selectedNote;
    String titleSnapshot = note.content.title;
    String bodySnapshot = note.content.content;
    Models.ProtectedBody protectedSnapshot = note.content.protectedContent;
    SecretKey protectionSnapshot = protectionKey;
    int revision = note.envelope.revision;
    saving = true;
    if (saveStatus != null) {
      saveStatus.setText("正在加密保存…");
      saveStatus.setTextColor(getColor(R.color.text_secondary));
    }
    runAsync(() -> {
      Models.NoteContent snapshot = new Models.NoteContent(
        titleSnapshot,
        bodySnapshot,
        protectedSnapshot
      );
      if (note.envelope.locked && note.unlocked) {
        if (protectionSnapshot == null) throw new IllegalStateException("保护密码需要重新验证。");
        snapshot.protectedContent = CryptoEngine.encryptProtectedBody(
          protectionSnapshot,
          note.envelope.id,
          bodySnapshot
        );
      }
      Models.NoteEnvelope updated = api.updateNote(
        CryptoEngine.encryptNote(dataKey, note.envelope.id, snapshot),
        revision
      );
      return new SavedNote(updated, snapshot.protectedContent);
    }, saved -> {
      saving = false;
      copyEnvelope(note.envelope, saved.envelope);
      note.content.protectedContent = saved.protectedContent;
      if (note.content.title.equals(titleSnapshot) && note.content.content.equals(bodySnapshot)) {
        dirty = false;
        if (saveStatus != null) {
          saveStatus.setText("已保存");
          saveStatus.setTextColor(getColor(R.color.brand_primary_dark));
        }
        if (afterSave != null) afterSave.run();
      } else {
        markDirty();
      }
    }, error -> {
      saving = false;
      dirty = true;
      if (saveStatus != null) {
        saveStatus.setText(error instanceof NotesApiClient.ApiException
          && ((NotesApiClient.ApiException) error).status == 409
          ? "版本冲突，请刷新"
          : "保存失败，请重试");
        saveStatus.setTextColor(getColor(R.color.danger));
      }
      showError(error);
    });
  }

  private void closeEditor() {
    keyboard(titleField, false);
    Runnable finish = () -> {
      if (selectedNote != null && selectedNote.envelope.locked && selectedNote.unlocked) {
        selectedNote.content.content = "";
        selectedNote.unlocked = false;
      }
      protectionKey = null;
      renderHome();
    };
    if (dirty) saveSelected(finish);
    else finish.run();
  }

  private void showEditorActions(View anchor) {
    if (selectedNote == null) return;
    PopupMenu menu = new PopupMenu(this, anchor);
    if (LOCATION_TRASH.equals(location)) {
      menu.getMenu().add(0, 40, 0, "恢复笔记").setIcon(R.drawable.ic_refresh);
      menu.getMenu().add(0, 41, 1, "永久删除").setIcon(R.drawable.ic_trash);
    } else {
      menu.getMenu().add(0, 30, 0, "移动到文件夹").setIcon(R.drawable.ic_folder);
      menu.getMenu().add(0, 31, 1, selectedNote.envelope.locked ? "移除正文保护" : "保护正文").setIcon(R.drawable.ic_lock);
      menu.getMenu().add(0, 32, 2, "移到回收站").setIcon(R.drawable.ic_trash);
    }
    menu.setOnMenuItemClickListener(item -> {
      if (item.getItemId() == 30) showFolderAssignment();
      else if (item.getItemId() == 31) {
        if (selectedNote.envelope.locked) unprotectSelected();
        else protectSelected();
      } else if (item.getItemId() == 32) moveSelectedToTrash();
      else if (item.getItemId() == 40) restoreSelected();
      else if (item.getItemId() == 41) purgeSelected();
      return true;
    });
    menu.show();
  }

  private void showFolderAssignment() {
    String[] names = new String[folders.size() + 1];
    names[0] = "未分类";
    for (int index = 0; index < folders.size(); index++) names[index + 1] = folders.get(index).name;
    new AlertDialog.Builder(this)
      .setTitle("移动到文件夹")
      .setItems(names, (dialog, index) -> {
        String folderId = index == 0 ? null : folders.get(index - 1).envelope.id;
        moveSelected(folderId);
      })
      .setNegativeButton("取消", null)
      .show();
  }

  private void moveSelected(String folderId) {
    if (selectedNote == null) return;
    Models.NoteDocument note = selectedNote;
    saveSelected(() -> {
      setSavingMessage("正在移动…");
      runAsync(
        () -> api.moveNote(note.envelope.id, folderId, note.envelope.revision),
        mutation -> {
          applyMutation(note.envelope, mutation);
          toast("已移动笔记");
          renderEditor();
        }
      );
    });
  }

  private void moveSelectedToTrash() {
    if (selectedNote == null) return;
    Models.NoteDocument note = selectedNote;
    new AlertDialog.Builder(this)
      .setTitle("移到回收站？")
      .setMessage("可以稍后从回收站恢复这条笔记。")
      .setNegativeButton("取消", null)
      .setPositiveButton("移到回收站", (dialog, which) -> saveSelected(() -> {
        showLoading("正在移动到回收站…");
        runAsync(() -> api.moveToTrash(note.envelope.id, note.envelope.revision), mutation -> {
          applyMutation(note.envelope, mutation);
          notes.remove(note);
          trash.add(0, note);
          selectedNote = null;
          renderHome();
        });
      }))
      .show();
  }

  private void restoreSelected() {
    if (selectedNote == null) return;
    Models.NoteDocument note = selectedNote;
    showLoading("正在恢复笔记…");
    runAsync(() -> api.restoreNote(note.envelope.id, note.envelope.revision), mutation -> {
      applyMutation(note.envelope, mutation);
      trash.remove(note);
      notes.add(0, note);
      selectedNote = null;
      renderHome();
    });
  }

  private void purgeSelected() {
    if (selectedNote == null) return;
    Models.NoteDocument note = selectedNote;
    new AlertDialog.Builder(this)
      .setTitle("永久删除？")
      .setMessage("这条笔记将无法恢复。")
      .setNegativeButton("取消", null)
      .setPositiveButton("永久删除", (dialog, which) -> {
        showLoading("正在永久删除…");
        runAsync(() -> {
          api.purgeNote(note.envelope.id, note.envelope.revision);
          return true;
        }, ignored -> {
          trash.remove(note);
          selectedNote = null;
          renderHome();
        });
      })
      .show();
  }

  private void protectSelected() {
    if (selectedNote == null) return;
    if (protectionKeyring == null) {
      showProtectionDialog(true, credentials -> {
        setSavingMessage("正在设置保护密码…");
        runAsync(() -> {
          CryptoEngine.ProtectionSetup setup = CryptoEngine.createProtectionKeyring(credentials.password);
          Models.ProtectionKeyring stored = api.createProtectionKeyring(setup.payload);
          return new StoredProtection(stored, setup.key);
        }, result -> {
          protectionKeyring = result.keyring;
          protectionKey = result.key;
          applyProtection();
        });
      });
    } else {
      showProtectionDialog(false, credentials -> unlockProtection(credentials.password, this::applyProtection));
    }
  }

  private void applyProtection() {
    if (selectedNote == null || protectionKey == null) return;
    try {
      selectedNote.content.protectedContent = CryptoEngine.encryptProtectedBody(
        protectionKey,
        selectedNote.envelope.id,
        selectedNote.content.content
      );
      selectedNote.envelope.locked = true;
      selectedNote.unlocked = true;
      markDirty();
      saveSelected(() -> toast("笔记正文已受保护"));
      renderEditor();
    } catch (Exception error) {
      showError(error);
    }
  }

  private void unlockSelected(Runnable afterUnlock) {
    if (selectedNote == null || protectionKeyring == null) {
      toast("尚未设置保护密码。");
      return;
    }
    showProtectionDialog(false, credentials -> unlockProtection(credentials.password, () -> {
      if (selectedNote == null || selectedNote.content.protectedContent == null) return;
      try {
        selectedNote.content.content = CryptoEngine.decryptProtectedBody(
          protectionKey,
          selectedNote.envelope.id,
          selectedNote.content.protectedContent
        );
        selectedNote.unlocked = true;
        if (afterUnlock != null) afterUnlock.run();
        else renderEditor();
      } catch (Exception error) {
        protectionKey = null;
        showError(error);
      }
    }));
  }

  private void unlockProtection(String password, Runnable success) {
    setSavingMessage("正在验证保护密码…");
    runAsync(
      () -> CryptoEngine.unlockProtectionKeyring(protectionKeyring, password),
      key -> {
        protectionKey = key;
        success.run();
      }
    );
  }

  private void unprotectSelected() {
    Runnable removeProtection = () -> {
      if (selectedNote == null) return;
      selectedNote.content.protectedContent = null;
      selectedNote.envelope.locked = false;
      selectedNote.unlocked = false;
      markDirty();
      saveSelected(() -> {
        protectionKey = null;
        toast("已移除正文保护");
      });
      renderEditor();
    };
    if (selectedNote != null && selectedNote.unlocked) removeProtection.run();
    else unlockSelected(removeProtection);
  }

  private void showProtectionDialog(boolean create, Consumer<ProtectionCredentials> completion) {
    LinearLayout fields = verticalLayout(8);
    fields.setPadding(dp(24), dp(8), dp(24), 0);
    TextView label = text(create ? "设置独立保护密码" : "独立保护密码", 14, R.color.text_primary);
    fields.addView(label, matchWrap(0, 0, 0, 4));
    EditText password = editText("至少 12 个字符", true);
    password.setSingleLine(true);
    fields.addView(password, matchHeight(dp(52), 0, 0, 0, 8));
    EditText confirmation = null;
    if (create) {
      TextView confirmationLabel = text("再次输入保护密码", 14, R.color.text_primary);
      fields.addView(confirmationLabel, matchWrap(0, 4, 0, 4));
      confirmation = editText("确认保护密码", true);
      confirmation.setSingleLine(true);
      fields.addView(confirmation, matchHeight(dp(52), 0, 0, 0, 8));
    }
    CheckBox show = new CheckBox(this);
    show.setText(R.string.show_password);
    show.setTextColor(getColor(R.color.text_secondary));
    show.setMinHeight(dp(48));
    EditText finalConfirmation = confirmation;
    show.setOnCheckedChangeListener((button, checked) -> {
      int type = InputType.TYPE_CLASS_TEXT
        | (checked ? InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD : InputType.TYPE_TEXT_VARIATION_PASSWORD);
      password.setInputType(type);
      password.setSelection(password.length());
      if (finalConfirmation != null) {
        finalConfirmation.setInputType(type);
        finalConfirmation.setSelection(finalConfirmation.length());
      }
    });
    fields.addView(show, matchHeight(dp(48), 0, 0, 0, 0));

    AlertDialog dialog = new AlertDialog.Builder(this)
      .setTitle(create ? "设置笔记保护" : "解锁受保护笔记")
      .setMessage(create ? "所有受保护笔记共用这个密码。密码不会上传或保存在本机。" : null)
      .setView(fields)
      .setNegativeButton("取消", null)
      .setPositiveButton(create ? "设置并保护" : "解锁", null)
      .create();
    dialog.setOnShowListener(ignored -> dialog.getButton(DialogInterface.BUTTON_POSITIVE)
      .setOnClickListener(view -> {
        String value = password.getText().toString();
        if (value.length() < 12) {
          password.setError("保护密码至少需要 12 个字符。");
          return;
        }
        if (finalConfirmation != null && !value.equals(finalConfirmation.getText().toString())) {
          finalConfirmation.setError("两次输入的保护密码不一致。");
          return;
        }
        dialog.dismiss();
        completion.accept(new ProtectionCredentials(value));
      }));
    dialog.show();
  }

  private void createFolder() {
    EditText name = editText("文件夹名称", false);
    name.setSingleLine(true);
    int padding = dp(24);
    FrameLayout wrapper = new FrameLayout(this);
    wrapper.setPadding(padding, dp(8), padding, 0);
    wrapper.addView(name, frameHeight(dp(52)));
    AlertDialog dialog = new AlertDialog.Builder(this)
      .setTitle("新建文件夹")
      .setView(wrapper)
      .setNegativeButton("取消", null)
      .setPositiveButton("创建", null)
      .create();
    dialog.setOnShowListener(ignored -> dialog.getButton(DialogInterface.BUTTON_POSITIVE)
      .setOnClickListener(view -> {
        String value = name.getText().toString().trim();
        if (value.isEmpty()) {
          name.setError("请输入文件夹名称。");
          return;
        }
        dialog.dismiss();
        String id = UUID.randomUUID().toString();
        showLoading("正在创建文件夹…");
        runAsync(() -> {
          Models.FolderEnvelope envelope = api.createFolder(CryptoEngine.encryptFolder(dataKey, id, value));
          return new Models.FolderDocument(envelope, value);
        }, folder -> {
          folders.add(folder);
          location = LOCATION_FOLDER_PREFIX + folder.envelope.id;
          renderHome();
        });
      }));
    dialog.show();
  }

  private void manageFolders() {
    String[] names = new String[folders.size()];
    for (int index = 0; index < folders.size(); index++) names[index] = folders.get(index).name;
    new AlertDialog.Builder(this)
      .setTitle("管理文件夹")
      .setItems(names, (dialog, index) -> showFolderActions(folders.get(index)))
      .setNegativeButton("完成", null)
      .show();
  }

  private void showFolderActions(Models.FolderDocument folder) {
    new AlertDialog.Builder(this)
      .setTitle(folder.name)
      .setItems(new String[] { "重命名", "删除文件夹" }, (dialog, index) -> {
        if (index == 0) renameFolder(folder);
        else confirmDeleteFolder(folder);
      })
      .setNegativeButton("取消", null)
      .show();
  }

  private void renameFolder(Models.FolderDocument folder) {
    EditText name = editText("文件夹名称", false);
    name.setSingleLine(true);
    name.setText(folder.name);
    name.selectAll();
    FrameLayout wrapper = new FrameLayout(this);
    wrapper.setPadding(dp(24), dp(8), dp(24), 0);
    wrapper.addView(name, frameHeight(dp(52)));
    AlertDialog dialog = new AlertDialog.Builder(this)
      .setTitle("重命名文件夹")
      .setView(wrapper)
      .setNegativeButton("取消", null)
      .setPositiveButton("保存", null)
      .create();
    dialog.setOnShowListener(ignored -> dialog.getButton(DialogInterface.BUTTON_POSITIVE)
      .setOnClickListener(view -> {
        String value = name.getText().toString().trim();
        if (value.isEmpty()) {
          name.setError("请输入文件夹名称。");
          return;
        }
        dialog.dismiss();
        if (demoMode) {
          folder.name = value;
          renderHome();
          return;
        }
        showLoading("正在重命名文件夹…");
        runAsync(() -> api.updateFolder(
          CryptoEngine.encryptFolder(dataKey, folder.envelope.id, value),
          folder.envelope.revision
        ), updated -> {
          folder.envelope.revision = updated.revision;
          folder.envelope.ciphertext = updated.ciphertext;
          folder.envelope.nonce = updated.nonce;
          folder.envelope.updatedAt = updated.updatedAt;
          folder.name = value;
          renderHome();
        });
      }));
    dialog.show();
  }

  private void confirmDeleteFolder(Models.FolderDocument folder) {
    new AlertDialog.Builder(this)
      .setTitle("删除“" + folder.name + "”？")
      .setMessage("文件夹中的笔记会移动到未分类，不会被删除。")
      .setNegativeButton("取消", null)
      .setPositiveButton("删除文件夹", (dialog, which) -> {
        if (demoMode) {
          for (Models.NoteDocument note : notes) {
            if (folder.envelope.id.equals(note.envelope.folderId)) {
              note.envelope.folderId = null;
              note.envelope.revision += 1;
            }
          }
          folders.remove(folder);
          if (location.equals(LOCATION_FOLDER_PREFIX + folder.envelope.id)) location = LOCATION_ALL;
          renderHome();
          return;
        }
        showLoading("正在删除文件夹…");
        runAsync(() -> {
          api.deleteFolder(folder.envelope.id, folder.envelope.revision);
          return true;
        }, ignored -> {
          if (location.equals(LOCATION_FOLDER_PREFIX + folder.envelope.id)) location = LOCATION_ALL;
          loadAllData();
        });
      })
      .show();
  }

  private void logout() {
    showLoading("正在退出登录…");
    runAsync(() -> {
      api.logout();
      return true;
    }, ignored -> {
      clearState();
      showLogin();
    });
  }

  private void clearState() {
    user = null;
    dataKey = null;
    protectionKeyring = null;
    protectionKey = null;
    selectedNote = null;
    notes.clear();
    trash.clear();
    folders.clear();
    searchQuery = "";
    location = LOCATION_ALL;
    handler.removeCallbacksAndMessages(null);
    dirty = false;
    saving = false;
  }

  private void showLoading(String message) {
    editorVisible = false;
    LinearLayout content = verticalLayout(0);
    content.setGravity(Gravity.CENTER);
    content.setBackgroundColor(getColor(R.color.background));
    ImageView icon = iconView(R.drawable.ic_note, R.color.on_brand, "My Notes", 26);
    icon.setPadding(dp(14), dp(14), dp(14), dp(14));
    icon.setBackground(roundedBackground(R.color.brand_primary, 18));
    content.addView(icon, new LinearLayout.LayoutParams(dp(60), dp(60)));
    ProgressBar progress = new ProgressBar(this);
    progress.setIndeterminateTintList(ColorStateList.valueOf(getColor(R.color.brand_primary)));
    LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(dp(40), dp(40));
    progressParams.setMargins(0, dp(22), 0, dp(8));
    content.addView(progress, progressParams);
    TextView label = text(message, 16, R.color.text_secondary);
    label.setGravity(Gravity.CENTER);
    content.addView(label, matchWrap(24, 0, 24, 0));
    setContentView(applySystemInsets(content));
  }

  private String locationTitle() {
    if (LOCATION_ALL.equals(location)) return "全部笔记";
    if (LOCATION_UNFILED.equals(location)) return "未分类";
    if (LOCATION_TRASH.equals(location)) return "回收站";
    String id = location.substring(LOCATION_FOLDER_PREFIX.length());
    for (Models.FolderDocument folder : folders) {
      if (folder.envelope.id.equals(id)) return folder.name;
    }
    return "文件夹";
  }

  private String folderName(String id) {
    if (id == null) return "未分类";
    for (Models.FolderDocument folder : folders) {
      if (folder.envelope.id.equals(id)) return folder.name;
    }
    return "未分类";
  }

  private String modeTitle() {
    return displayMode == 0 ? "列表" : displayMode == 1 ? "卡片" : "标题";
  }

  private String saveStatusText() {
    if (saving) return "正在保存…";
    if (dirty) return "有未保存更改";
    return selectedNote != null && selectedNote.envelope.locked ? "正文受保护" : "内容已解密";
  }

  private void setSavingMessage(String value) {
    if (saveStatus != null) {
      saveStatus.setText(value);
      saveStatus.setTextColor(getColor(R.color.text_secondary));
    }
  }

  private static void applyMutation(Models.NoteEnvelope envelope, JSONObject json) {
    envelope.folderId = Models.nullableString(json, "folderId");
    envelope.revision = json.optInt("revision", envelope.revision);
    envelope.updatedAt = Models.nullableString(json, "updatedAt");
    envelope.deletedAt = Models.nullableString(json, "deletedAt");
    envelope.locked = json.optBoolean("isLocked", envelope.locked);
  }

  private static void copyEnvelope(Models.NoteEnvelope target, Models.NoteEnvelope source) {
    target.folderId = source.folderId;
    target.revision = source.revision;
    target.ciphertext = source.ciphertext;
    target.nonce = source.nonce;
    target.updatedAt = source.updatedAt;
    target.deletedAt = source.deletedAt;
    target.locked = source.locked;
  }

  private <T> void runAsync(Callable<T> work, Consumer<T> success) {
    runAsync(work, success, this::showError);
  }

  private <T> void runAsync(Callable<T> work, Consumer<T> success, Consumer<Exception> failure) {
    executor.submit(() -> {
      try {
        T result = work.call();
        runOnUiThread(() -> success.accept(result));
      } catch (Exception error) {
        runOnUiThread(() -> failure.accept(error));
      }
    });
  }

  private void showError(Exception error) {
    String message = error.getMessage();
    if (message == null || message.trim().isEmpty()) message = "操作失败，请稍后重试。";
    toast(message);
    if (!editorVisible && user == null) {
      showLogin();
    } else if (!editorVisible) {
      String finalMessage = message;
      new AlertDialog.Builder(this)
        .setTitle("无法加载笔记")
        .setMessage(finalMessage)
        .setPositiveButton("重新加载", (dialog, which) -> loadAllData())
        .setNegativeButton("取消", null)
        .show();
    }
  }

  private void toast(String message) {
    Toast.makeText(this, message, Toast.LENGTH_LONG).show();
  }

  private void keyboard(View view, boolean show) {
    if (view == null) return;
    InputMethodManager input = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
    if (show) input.showSoftInput(view, InputMethodManager.SHOW_IMPLICIT);
    else input.hideSoftInputFromWindow(view.getWindowToken(), 0);
  }

  private <T extends View> T applySystemInsets(T view) {
    int left = view.getPaddingLeft();
    int top = view.getPaddingTop();
    int right = view.getPaddingRight();
    int bottom = view.getPaddingBottom();
    view.setOnApplyWindowInsetsListener((target, insets) -> {
      Insets bars = insets.getInsets(
        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout()
      );
      target.setPadding(
        left + bars.left,
        top + bars.top,
        right + bars.right,
        bottom + bars.bottom
      );
      return insets;
    });
    view.requestApplyInsets();
    return view;
  }

  private LinearLayout verticalLayout(int spacing) {
    LinearLayout layout = new LinearLayout(this);
    layout.setOrientation(LinearLayout.VERTICAL);
    if (spacing > 0) layout.setDividerPadding(dp(spacing));
    return layout;
  }

  private LinearLayout horizontalLayout(int gravity) {
    LinearLayout layout = new LinearLayout(this);
    layout.setOrientation(LinearLayout.HORIZONTAL);
    layout.setGravity(gravity);
    return layout;
  }

  private TextView text(String value, float size, int color) {
    TextView view = new TextView(this);
    view.setText(value);
    view.setTextSize(size);
    view.setTextColor(getColor(color));
    view.setGravity(Gravity.CENTER_VERTICAL);
    view.setIncludeFontPadding(false);
    return view;
  }

  private EditText editText(String hint, boolean password) {
    EditText field = new EditText(this);
    field.setHint(hint);
    field.setTextColor(getColor(R.color.text_primary));
    field.setHintTextColor(getColor(R.color.text_secondary));
    field.setTextSize(16);
    field.setPadding(dp(16), dp(8), dp(16), dp(8));
    StateListDrawable background = new StateListDrawable();
    background.addState(
      new int[] { android.R.attr.state_focused },
      roundedStrokeBackground(R.color.surface, R.color.brand_primary, 16, 2)
    );
    background.addState(
      new int[] {},
      roundedStrokeBackground(R.color.surface, R.color.divider, 16, 1)
    );
    field.setBackground(background);
    if (password) {
      field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
    }
    return field;
  }

  private Drawable roundedBackground(int colorRes, int radiusDp) {
    GradientDrawable drawable = new GradientDrawable();
    drawable.setColor(getColor(colorRes));
    drawable.setCornerRadius(dp(radiusDp));
    return drawable;
  }

  private Drawable roundedStrokeBackground(
    int colorRes,
    int strokeColorRes,
    int radiusDp,
    int strokeDp
  ) {
    GradientDrawable drawable = new GradientDrawable();
    drawable.setColor(getColor(colorRes));
    drawable.setCornerRadius(dp(radiusDp));
    drawable.setStroke(dp(strokeDp), getColor(strokeColorRes));
    return drawable;
  }

  private Drawable rippleBackground(int colorRes, int radiusDp) {
    GradientDrawable content = new GradientDrawable();
    content.setColor(getColor(colorRes));
    content.setCornerRadius(dp(radiusDp));
    GradientDrawable mask = new GradientDrawable();
    mask.setColor(Color.WHITE);
    mask.setCornerRadius(dp(radiusDp));
    return new RippleDrawable(
      ColorStateList.valueOf(getColor(R.color.surface_high)),
      content,
      mask
    );
  }

  private Drawable rippleStrokeBackground(int colorRes, int strokeColorRes, int radiusDp) {
    GradientDrawable content = new GradientDrawable();
    content.setColor(getColor(colorRes));
    content.setCornerRadius(dp(radiusDp));
    content.setStroke(dp(1), getColor(strokeColorRes));
    GradientDrawable mask = new GradientDrawable();
    mask.setColor(Color.WHITE);
    mask.setCornerRadius(dp(radiusDp));
    return new RippleDrawable(
      ColorStateList.valueOf(getColor(R.color.surface_high)),
      content,
      mask
    );
  }

  private ImageView iconView(int drawableRes, int tintRes, String description, int iconDp) {
    ImageView icon = new ImageView(this);
    icon.setImageResource(drawableRes);
    icon.setImageTintList(ColorStateList.valueOf(getColor(tintRes)));
    icon.setContentDescription(description);
    icon.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
    icon.setMinimumWidth(dp(iconDp));
    icon.setMinimumHeight(dp(iconDp));
    return icon;
  }

  private ImageButton iconButton(int drawableRes, String description, boolean tonal) {
    ImageButton button = new ImageButton(this);
    button.setImageResource(drawableRes);
    button.setImageTintList(ColorStateList.valueOf(getColor(R.color.brand_primary_dark)));
    button.setContentDescription(description);
    button.setPadding(dp(12), dp(12), dp(12), dp(12));
    button.setBackground(rippleBackground(tonal ? R.color.surface_tonal : R.color.background, 16));
    button.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
    button.setMinimumWidth(dp(48));
    button.setMinimumHeight(dp(48));
    return button;
  }

  private IconTextButton primaryIconButton(String label, int drawableRes) {
    return new IconTextButton(label, drawableRes);
  }

  private Button chipButton(String label, int drawableRes, boolean selected) {
    Button button = new Button(this);
    button.setText(label);
    button.setTextSize(13);
    button.setAllCaps(false);
    button.setGravity(Gravity.CENTER);
    button.setMinHeight(dp(40));
    button.setMinWidth(dp(48));
    button.setPadding(dp(14), 0, dp(14), 0);
    button.setTextColor(getColor(selected ? R.color.on_brand : R.color.text_primary));
    Drawable icon = getDrawable(drawableRes);
    icon.setTint(getColor(selected ? R.color.on_brand : R.color.text_secondary));
    icon.setBounds(0, 0, dp(18), dp(18));
    button.setCompoundDrawablePadding(dp(7));
    button.setCompoundDrawables(icon, null, null, null);
    button.setBackground(rippleBackground(selected ? R.color.brand_primary : R.color.surface, 14));
    button.setContentDescription(label + (selected ? "，已选择" : ""));
    button.setSelected(selected);
    return button;
  }

  private int modeIcon() {
    return displayMode == 0 ? R.drawable.ic_list : displayMode == 1 ? R.drawable.ic_grid : R.drawable.ic_title;
  }

  private int dp(int value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }

  private LinearLayout.LayoutParams matchWrap(int left, int top, int right, int bottom) {
    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    );
    params.setMargins(dp(left), dp(top), dp(right), dp(bottom));
    return params;
  }

  private LinearLayout.LayoutParams matchHeight(int height, int left, int top, int right, int bottom) {
    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      height
    );
    params.setMargins(dp(left), dp(top), dp(right), dp(bottom));
    return params;
  }

  private FrameLayout.LayoutParams frameMatch() {
    return new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    );
  }

  private FrameLayout.LayoutParams frameHeight(int height) {
    return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, height);
  }

  private static abstract class SimpleTextWatcher implements TextWatcher {
    @Override public void beforeTextChanged(CharSequence value, int start, int count, int after) {}
    @Override public void onTextChanged(CharSequence value, int start, int before, int count) {}
  }

  private final class IconTextButton extends LinearLayout {
    private final TextView labelView;

    IconTextButton(String label, int drawableRes) {
      super(MainActivity.this);
      setOrientation(HORIZONTAL);
      setGravity(Gravity.CENTER);
      setPadding(dp(18), 0, dp(18), 0);
      setMinimumHeight(dp(48));
      setClickable(true);
      setFocusable(true);
      setContentDescription(label);
      setBackground(rippleBackground(R.color.brand_primary, 18));

      ImageView icon = iconView(drawableRes, R.color.on_brand, null, 22);
      addView(icon, new LinearLayout.LayoutParams(dp(22), dp(22)));
      labelView = text(label, 16, R.color.on_brand);
      labelView.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
      LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      );
      labelParams.setMarginStart(dp(10));
      addView(labelView, labelParams);
    }

    void setText(String value) {
      labelView.setText(value);
      setContentDescription(value);
    }

    @Override
    public void setEnabled(boolean enabled) {
      super.setEnabled(enabled);
      setAlpha(enabled ? 1f : 0.5f);
    }

    @Override
    public CharSequence getAccessibilityClassName() {
      return Button.class.getName();
    }
  }

  private final class NotesAdapter extends BaseAdapter {
    @Override public int getCount() { return visibleNotes.size(); }
    @Override public Models.NoteDocument getItem(int position) { return visibleNotes.get(position); }
    @Override public long getItemId(int position) { return position; }

    @Override
    public View getView(int position, View recycled, ViewGroup parent) {
      Models.NoteDocument note = getItem(position);
      FrameLayout outer = new FrameLayout(MainActivity.this);
      outer.setPadding(dp(4), dp(4), dp(4), dp(4));
      LinearLayout cell = verticalLayout(0);
      cell.setPadding(dp(16), dp(15), dp(16), dp(14));
      cell.setBackground(rippleStrokeBackground(
        displayMode == 1 ? R.color.surface_variant : R.color.surface,
        R.color.divider,
        18
      ));
      cell.setMinimumHeight(dp(displayMode == 1 ? 176 : displayMode == 2 ? 72 : 116));

      LinearLayout titleRow = horizontalLayout(Gravity.CENTER_VERTICAL);
      if (note.envelope.locked) {
        ImageView lock = iconView(R.drawable.ic_lock, R.color.brand_primary_dark, "受保护笔记", 16);
        titleRow.addView(lock, new LinearLayout.LayoutParams(dp(26), dp(26)));
      }
      TextView title = text(note.title(), displayMode == 1 ? 18 : 17, R.color.text_primary);
      title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
      title.setMaxLines(displayMode == 1 ? 2 : 1);
      title.setEllipsize(android.text.TextUtils.TruncateAt.END);
      LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
      if (note.envelope.locked) titleParams.setMarginStart(dp(6));
      titleRow.addView(title, titleParams);
      cell.addView(titleRow, matchWrap(0, 0, 0, 7));

      if (displayMode != 2) {
        TextView excerpt = text(note.excerpt(), 14, R.color.text_secondary);
        excerpt.setLineSpacing(dp(2), 1.12f);
        excerpt.setMaxLines(displayMode == 1 ? 4 : 2);
        excerpt.setEllipsize(android.text.TextUtils.TruncateAt.END);
        cell.addView(excerpt, new LinearLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          displayMode == 1 ? 0 : ViewGroup.LayoutParams.WRAP_CONTENT,
          displayMode == 1 ? 1 : 0
        ));
      }
      LinearLayout metadata = horizontalLayout(Gravity.CENTER_VERTICAL);
      ImageView folderIcon = iconView(R.drawable.ic_folder, R.color.text_secondary, "所在文件夹", 14);
      metadata.addView(folderIcon, new LinearLayout.LayoutParams(dp(22), dp(22)));
      TextView folder = text(folderName(note.envelope.folderId), 12, R.color.text_secondary);
      folder.setMaxLines(1);
      folder.setEllipsize(android.text.TextUtils.TruncateAt.END);
      metadata.addView(folder, new LinearLayout.LayoutParams(0, dp(28), 1));
      TextView date = text(note.envelope.displayDate(), 12, R.color.text_secondary);
      date.setGravity(Gravity.CENTER_VERTICAL | Gravity.END);
      metadata.addView(date, new LinearLayout.LayoutParams(dp(64), dp(28)));
      cell.addView(metadata, matchWrap(0, displayMode == 2 ? 2 : 10, 0, 0));
      outer.addView(cell, frameMatch());
      return outer;
    }
  }

  private static final class LoadedData {
    final SecretKey dataKey;
    final Models.ProtectionKeyring keyring;
    final List<Models.FolderDocument> folders;
    final List<Models.NoteDocument> notes;
    final List<Models.NoteDocument> trash;

    LoadedData(
      SecretKey dataKey,
      Models.ProtectionKeyring keyring,
      List<Models.FolderDocument> folders,
      List<Models.NoteDocument> notes,
      List<Models.NoteDocument> trash
    ) {
      this.dataKey = dataKey;
      this.keyring = keyring;
      this.folders = folders;
      this.notes = notes;
      this.trash = trash;
    }
  }

  private static final class SavedNote {
    final Models.NoteEnvelope envelope;
    final Models.ProtectedBody protectedContent;

    SavedNote(Models.NoteEnvelope envelope, Models.ProtectedBody protectedContent) {
      this.envelope = envelope;
      this.protectedContent = protectedContent;
    }
  }

  private static final class StoredProtection {
    final Models.ProtectionKeyring keyring;
    final SecretKey key;

    StoredProtection(Models.ProtectionKeyring keyring, SecretKey key) {
      this.keyring = keyring;
      this.key = key;
    }
  }

  private static final class ProtectionCredentials {
    final String password;
    ProtectionCredentials(String password) { this.password = password; }
  }
}
