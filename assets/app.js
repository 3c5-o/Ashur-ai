(function(){
    "use strict";

    var STORAGE_KEY = "ashur_ai_state_v4";
    var SETTINGS_KEY = "ashur_ai_settings_v4";
    var META_KEY = "ashur_ai_meta_v5";
    var DB_NAME = "ashur_ai_db";
    var DB_STORE = "app";
    var DB_STATE_KEY = "state";
    var dbPromise = null;
    var persistTimer = null;

    var state = loadState();
    var settings = loadSettings();
    var activeId = state.activeId;
    var pendingAttachments = [];
    var currentController = null;
    var generating = false;
    var deferredInstallPrompt = null;

    var sidebar = document.getElementById("sidebar");
    var backdrop = document.getElementById("backdrop");
    var chatList = document.getElementById("chatList");
    var chatSearch = document.getElementById("chatSearch");
    var messagesEl = document.getElementById("messages");
    var emptyState = document.getElementById("emptyState");
    var activeTitle = document.getElementById("activeTitle");
    var statusText = document.getElementById("statusText");
    var modeSelect = document.getElementById("modeSelect");
    var modelSelect = document.getElementById("modelSelect");
    var input = document.getElementById("messageInput");
    var sendBtn = document.getElementById("sendBtn");
    var attachBtn = document.getElementById("attachBtn");
    var voiceBtn = document.getElementById("voiceBtn");
    var imageBtn = document.getElementById("imageBtn");
    var inputUsage = document.getElementById("inputUsage");
    var imageModal = document.getElementById("imageModal");
    var imagePrompt = document.getElementById("imagePrompt");
    var imageModel = document.getElementById("imageModel");
    var generateImageBtn = document.getElementById("generateImageBtn");
    var fileInput = document.getElementById("fileInput");
    var attachmentBar = document.getElementById("attachmentBar");
    var toastEl = document.getElementById("toast");
    var settingsModal = document.getElementById("settingsModal");
    var themeSetting = document.getElementById("themeSetting");
    var fontSetting = document.getElementById("fontSetting");
    var tempSetting = document.getElementById("tempSetting");
    var enterSetting = document.getElementById("enterSetting");
    var longOutputSetting = document.getElementById("longOutputSetting");
    var continuationSetting = document.getElementById("continuationSetting");
    var customInstructions = document.getElementById("customInstructions");
    var customKnowledge = document.getElementById("customKnowledge");
    var linkChatsBtn = document.getElementById("linkChatsBtn");
    var linkedCount = document.getElementById("linkedCount");
    var linkedContextStrip = document.getElementById("linkedContextStrip");
    var linkModal = document.getElementById("linkModal");
    var linkedChatList = document.getElementById("linkedChatList");
    var clearLinksBtn = document.getElementById("clearLinksBtn");

    function uid(prefix){
      return (prefix || "id") + "_" + Date.now() + "_" + Math.random().toString(36).slice(2,9);
    }

    function defaultSettings(){
      return {
        theme:"dark",
        fontSize:15,
        temperature:0.7,
        enterToSend:true,
        longOutput:true,
        maxContinuations:6,
        imageModel:"auto",
        defaultModel:"auto",
        customInstructions:"",
        customKnowledge:""
      };
    }

    function loadSettings(){
      try{
        return Object.assign(defaultSettings(), JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"));
      }catch(e){
        return defaultSettings();
      }
    }

    function saveSettings(){
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      applySettings();
    }

    function openDatabase(){
      if(dbPromise) return dbPromise;

      dbPromise = new Promise(function(resolve,reject){
        if(!("indexedDB" in window)){
          reject(new Error("IndexedDB غير مدعوم"));
          return;
        }

        var request = indexedDB.open(DB_NAME,1);

        request.onupgradeneeded = function(){
          var db = request.result;
          if(!db.objectStoreNames.contains(DB_STORE)){
            db.createObjectStore(DB_STORE);
          }
        };

        request.onsuccess = function(){ resolve(request.result); };
        request.onerror = function(){ reject(request.error || new Error("تعذر فتح التخزين")); };
      });

      return dbPromise;
    }

    async function readStateFromDb(){
      try{
        var db = await openDatabase();
        return await new Promise(function(resolve,reject){
          var tx = db.transaction(DB_STORE,"readonly");
          var store = tx.objectStore(DB_STORE);
          var req = store.get(DB_STATE_KEY);
          req.onsuccess = function(){ resolve(req.result || null); };
          req.onerror = function(){ reject(req.error); };
        });
      }catch(error){
        return null;
      }
    }

    async function persistStateNow(){
      try{
        var db = await openDatabase();
        var snapshot = JSON.parse(JSON.stringify(state));
        await new Promise(function(resolve,reject){
          var tx = db.transaction(DB_STORE,"readwrite");
          var store = tx.objectStore(DB_STORE);
          store.put(snapshot,DB_STATE_KEY);
          tx.oncomplete = function(){ resolve(); };
          tx.onerror = function(){ reject(tx.error); };
          tx.onabort = function(){ reject(tx.error); };
        });

        localStorage.setItem(META_KEY,JSON.stringify({
          activeId:activeId,
          updatedAt:Date.now()
        }));

        // Remove old large LocalStorage state only after IndexedDB has a valid copy.
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem("ashur_ai_messages");
      }catch(error){
        console.warn("IndexedDB persist failed",error);
      }
    }

    function schedulePersist(){
      clearTimeout(persistTimer);
      persistTimer = setTimeout(function(){
        persistStateNow();
      },220);
    }

    async function clearStateDb(){
      try{
        var db = await openDatabase();
        await new Promise(function(resolve,reject){
          var tx = db.transaction(DB_STORE,"readwrite");
          tx.objectStore(DB_STORE).delete(DB_STATE_KEY);
          tx.oncomplete = function(){ resolve(); };
          tx.onerror = function(){ reject(tx.error); };
          tx.onabort = function(){ reject(tx.error); };
        });
      }catch(error){
        console.warn("IndexedDB clear failed",error);
      }
    }

    async function hydrateStateFromDb(){
      var stored = await readStateFromDb();

      if(stored && Array.isArray(stored.chats) && stored.chats.length){
        state = stored;
        state.chats = state.chats.map(normalizeChat);
        activeId = stored.activeId || stored.chats[0].id;
        return;
      }

      // First run after upgrade: migrate current LocalStorage state into IndexedDB.
      await persistStateNow();
    }

    function loadState(){
      try{
        var parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
        if(parsed && Array.isArray(parsed.chats)) return parsed;
      }catch(e){}

      var legacy = [];
      try{
        legacy = JSON.parse(localStorage.getItem("ashur_ai_messages") || "[]");
      }catch(e){}

      var first = {
        id:uid("chat"),
        title:"محادثة جديدة",
        mode:"general",
        model:settings ? (settings.defaultModel || "auto") : "auto",
        linkedChatIds:[],
        createdAt:Date.now(),
        updatedAt:Date.now(),
        messages:Array.isArray(legacy) ? legacy.map(function(m){
          return {
            id:uid("msg"),
            role:m.role === "ai" ? "assistant" : "user",
            text:String(m.text || ""),
            time:m.time || "",
            attachments:[]
          };
        }) : []
      };

      return {activeId:first.id,chats:[first]};
    }

    function saveState(){
      state.activeId = activeId;
      schedulePersist();
    }

    function normalizeChat(chat){
      if(!chat) return chat;
      if(!chat.mode) chat.mode = "general";
      if(!chat.model) chat.model = settings.defaultModel || "auto";
      if(!Array.isArray(chat.linkedChatIds)) chat.linkedChatIds = [];
      if(!Array.isArray(chat.messages)) chat.messages = [];
      return chat;
    }

    function currentChat(){
      var found = state.chats.find(function(c){return c.id === activeId;});
      if(found) return normalizeChat(found);
      if(!state.chats.length) createChat();
      return state.chats[0];
    }

    function createChat(){
      var chat = {
        id:uid("chat"),
        title:"محادثة جديدة",
        mode:"general",
        model:settings.defaultModel || "auto",
        linkedChatIds:[],
        createdAt:Date.now(),
        updatedAt:Date.now(),
        messages:[]
      };
      state.chats.unshift(chat);
      activeId = chat.id;
      saveState();
      renderAll();
      closeSidebar();
      setTimeout(function(){input.focus();},50);
      return chat;
    }

    function autoTitle(text){
      var clean = String(text || "").replace(/\s+/g," ").trim();
      if(!clean) return "محادثة جديدة";
      return clean.length > 34 ? clean.slice(0,34) + "…" : clean;
    }

    function formatTime(ts){
      try{
        var d = new Date(ts);
        var now = new Date();
        if(d.toDateString() === now.toDateString()){
          return d.toLocaleTimeString("ar-IQ",{hour:"2-digit",minute:"2-digit"});
        }
        return d.toLocaleDateString("ar-IQ",{month:"short",day:"numeric"});
      }catch(e){return "";}
    }

    function applySettings(){
      document.documentElement.setAttribute("data-theme",settings.theme);
      document.documentElement.style.setProperty("--font-size",settings.fontSize + "px");
      document.querySelector('meta[name="theme-color"]').setAttribute("content",settings.theme === "light" ? "#f4f7f5" : "#0b0f0e");
      themeSetting.value = settings.theme;
      fontSetting.value = settings.fontSize;
      tempSetting.value = settings.temperature;
      enterSetting.checked = !!settings.enterToSend;
      longOutputSetting.checked = settings.longOutput !== false;
      continuationSetting.value = String(settings.maxContinuations || 6);
      imageModel.value = settings.imageModel || "auto";
      customInstructions.value = settings.customInstructions || "";
      customKnowledge.value = settings.customKnowledge || "";
    }

    function renderAll(){
      renderChats();
      renderMessages();
      var chat = currentChat();
      activeTitle.textContent = chat.title;
      modeSelect.value = chat.mode || "general";
      modelSelect.value = chat.model || settings.defaultModel || "auto";
      renderLinkedContextStrip();
    }

    function renderChats(){
      var q = chatSearch.value.trim().toLowerCase();
      chatList.innerHTML = "";

      var filtered = state.chats.filter(function(chat){
        if(!q) return true;
        if(chat.title.toLowerCase().indexOf(q) !== -1) return true;
        return chat.messages.some(function(m){
          return String(m.text || "").toLowerCase().indexOf(q) !== -1;
        });
      });

      if(!filtered.length){
        var no = document.createElement("div");
        no.className = "no-results";
        no.textContent = "ماكو نتائج";
        chatList.appendChild(no);
        return;
      }

      filtered.sort(function(a,b){return b.updatedAt - a.updatedAt;}).forEach(function(chat){
        var item = document.createElement("div");
        item.className = "chat-item" + (chat.id === activeId ? " active" : "");

        var main = document.createElement("div");
        main.className = "chat-main";
        main.innerHTML = '<div class="chat-title"></div><div class="chat-time"></div>';
        main.querySelector(".chat-title").textContent = chat.title;
        main.querySelector(".chat-time").textContent = formatTime(chat.updatedAt);
        main.addEventListener("click",function(){
          activeId = chat.id;
          saveState();
          renderAll();
          closeSidebar();
        });

        var menu = document.createElement("button");
        menu.className = "chat-menu";
        menu.textContent = "⋯";
        menu.setAttribute("aria-label","خيارات");
        menu.addEventListener("click",function(e){
          e.stopPropagation();
          chatMenu(chat);
        });

        item.appendChild(main);
        item.appendChild(menu);
        chatList.appendChild(item);
      });
    }

    function chatMenu(chat){
      var action = prompt("اكتب:\n1 لإعادة التسمية\n2 للحذف", "1");
      if(action === "1"){
        var name = prompt("اسم المحادثة",chat.title);
        if(name && name.trim()){
          chat.title = name.trim().slice(0,70);
          chat.updatedAt = Date.now();
          saveState();
          renderAll();
        }
      }else if(action === "2"){
        if(confirm("حذف هذه المحادثة؟")){
          state.chats = state.chats.filter(function(c){return c.id !== chat.id;});
          if(!state.chats.length){
            var fresh = {
              id:uid("chat"),title:"محادثة جديدة",mode:"general",
              model:settings.defaultModel || "auto",linkedChatIds:[],
              createdAt:Date.now(),updatedAt:Date.now(),messages:[]
            };
            state.chats.push(fresh);
          }
          if(chat.id === activeId) activeId = state.chats[0].id;
          saveState();
          renderAll();
        }
      }
    }

    function linkedChatsFor(chat){
      var ids = Array.isArray(chat.linkedChatIds) ? chat.linkedChatIds : [];
      return ids
        .map(function(id){ return state.chats.find(function(c){ return c.id === id; }); })
        .filter(function(c){ return c && c.id !== chat.id; })
        .slice(0,3);
    }

    function buildLinkedContext(chat){
      var linked = linkedChatsFor(chat);
      if(!linked.length) return "";

      var sections = [];
      var total = 0;

      linked.forEach(function(other){
        var rows = other.messages
          .filter(function(m){ return m && !m.streaming && (m.role === "user" || m.role === "assistant") && m.text; })
          .slice(-8)
          .map(function(m){
            return (m.role === "assistant" ? "Ashur" : "المستخدم") + ": " + String(m.text || "").slice(0,5000);
          });

        var section = "[محادثة مستدعاة: " + other.title + "]\n" + rows.join("\n");
        if(total + section.length <= 35000){
          sections.push(section);
          total += section.length;
        }
      });

      return sections.join("\n\n");
    }

    function renderLinkedContextStrip(){
      var chat = currentChat();
      var linked = linkedChatsFor(chat);
      linkedContextStrip.innerHTML = "";
      linkedCount.textContent = String(linked.length);
      linkedCount.style.display = linked.length ? "grid" : "none";

      linked.forEach(function(other){
        var pill = document.createElement("div");
        pill.className = "linked-context-pill";

        var name = document.createElement("span");
        name.textContent = "استدعاء: " + other.title;

        var remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "×";
        remove.addEventListener("click",function(){
          chat.linkedChatIds = chat.linkedChatIds.filter(function(id){ return id !== other.id; });
          saveState();
          renderLinkedContextStrip();
        });

        pill.appendChild(name);
        pill.appendChild(remove);
        linkedContextStrip.appendChild(pill);
      });
    }

    function renderLinkedChatList(){
      var chat = currentChat();
      linkedChatList.innerHTML = "";

      var others = state.chats
        .filter(function(item){ return item.id !== chat.id; })
        .sort(function(a,b){ return b.updatedAt - a.updatedAt; });

      if(!others.length){
        var empty = document.createElement("div");
        empty.className = "no-results";
        empty.textContent = "ماكو محادثة ثانية للاستدعاء بعد.";
        linkedChatList.appendChild(empty);
        return;
      }

      others.forEach(function(other){
        var row = document.createElement("label");
        row.className = "link-chat-row";

        var checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = chat.linkedChatIds.indexOf(other.id) !== -1;

        var copy = document.createElement("div");
        var title = document.createElement("strong");
        title.textContent = other.title;
        var meta = document.createElement("small");
        meta.textContent = other.messages.length + " رسالة · " + formatTime(other.updatedAt);

        copy.appendChild(title);
        copy.appendChild(meta);
        row.appendChild(checkbox);
        row.appendChild(copy);

        checkbox.addEventListener("change",function(){
          chat.linkedChatIds = Array.isArray(chat.linkedChatIds) ? chat.linkedChatIds : [];
          if(checkbox.checked){
            if(chat.linkedChatIds.indexOf(other.id) === -1 && chat.linkedChatIds.length < 3){
              chat.linkedChatIds.push(other.id);
            }else if(chat.linkedChatIds.length >= 3){
              checkbox.checked = false;
              showToast("تقدر تستدعي حتى 3 محادثات بنفس الوقت.");
            }
          }else{
            chat.linkedChatIds = chat.linkedChatIds.filter(function(id){ return id !== other.id; });
          }
          saveState();
          renderLinkedContextStrip();
        });

        linkedChatList.appendChild(row);
      });
    }

    function openLinkModal(){
      renderLinkedChatList();
      linkModal.classList.add("open");
    }

    function closeLinkModal(){
      linkModal.classList.remove("open");
    }

    function escapeHtml(text){
      return String(text || "")
        .replace(/&/g,"&amp;")
        .replace(/</g,"&lt;")
        .replace(/>/g,"&gt;")
        .replace(/"/g,"&quot;");
    }

    function codeExtension(lang){
      var map = {
        javascript:"js",js:"js",typescript:"ts",ts:"ts",python:"py",py:"py",
        html:"html",css:"css",json:"json",java:"java",kotlin:"kt",dart:"dart",
        php:"php",sql:"sql",bash:"sh",shell:"sh",c:"c",cpp:"cpp",csharp:"cs",
        go:"go",rust:"rs",swift:"swift",xml:"xml",yaml:"yml",yml:"yml"
      };
      return map[String(lang || "").toLowerCase()] || "txt";
    }

    function renderMarkdown(text){
      var source = String(text || "");
      var blocks = [];

      source = source.replace(/\`\`\`([^\n]*)\n?([\s\S]*?)\`\`\`/g,function(_,lang,code){
        var idx = blocks.length;
        var normalizedLang = (lang || "code").trim() || "code";
        var cleanCode = code.replace(/^\n/,"").replace(/\n$/,"");
        var lineCount = cleanCode ? cleanCode.split("\n").length : 1;
        var numbers = Array.from({length:lineCount},function(_,i){return i+1;}).join("\n");

        blocks.push(
          '<div class="code-wrap" data-lang="' + escapeHtml(normalizedLang) + '">' +
            '<div class="code-head">' +
              '<div class="code-meta">' +
                '<span class="code-lang">' + escapeHtml(normalizedLang) + '</span>' +
                '<span class="code-lines-count">' + lineCount + ' سطر</span>' +
              '</div>' +
              '<div class="code-actions">' +
                '<button class="code-action" data-code-action="copy">نسخ</button>' +
                '<button class="code-action" data-code-action="download">تنزيل</button>' +
                '<button class="code-action" data-code-action="expand">تكبير</button>' +
              '</div>' +
            '</div>' +
            '<div class="code-scroll">' +
              '<div class="line-numbers">' + numbers + '</div>' +
              '<pre><code>' + escapeHtml(cleanCode) + '</code></pre>' +
            '</div>' +
          '</div>'
        );

        return "@@CODE_" + idx + "@@";
      });

      source = escapeHtml(source);
      source = source.replace(/^### (.+)$/gm,"<h3>$1</h3>");
      source = source.replace(/^## (.+)$/gm,"<h2>$1</h2>");
      source = source.replace(/^# (.+)$/gm,"<h1>$1</h1>");
      source = source.replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>");
      source = source.replace(/\`([^\`\n]+)\`/g,'<code class="inline">$1</code>');
      source = source.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,function(_,label,url){
        return '<a href="' + url.replace(/&amp;/g,"&") + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
      });
      source = source.replace(/^[-*] (.+)$/gm,"• $1");
      source = source.replace(/\n/g,"<br>");

      blocks.forEach(function(block,idx){
        source = source.replace("@@CODE_" + idx + "@@",block);
      });

      return source;
    }

    function renderMessages(){
      var chat = currentChat();
      messagesEl.querySelectorAll(".message,.inline-error").forEach(function(el){el.remove();});
      emptyState.style.display = chat.messages.length ? "none" : "grid";

      chat.messages.forEach(function(msg){
        appendMessageElement(msg);
      });

      activeTitle.textContent = chat.title;
      modeSelect.value = chat.mode || "general";
      modelSelect.value = chat.model || settings.defaultModel || "auto";
      renderLinkedContextStrip();
      scrollBottom(false);
    }

    function appendMessageElement(msg){
      emptyState.style.display = "none";

      var row = document.createElement("article");
      row.className = "message " + msg.role;
      row.dataset.id = msg.id;

      var avatar = document.createElement("div");
      avatar.className = "avatar";
      avatar.textContent = msg.role === "assistant" ? "A" : "أ";

      var body = document.createElement("div");
      body.className = "msg-body";

      var label = document.createElement("div");
      label.className = "msg-label";
      label.textContent = msg.role === "assistant" ? "Ashur AI" : "أنت";

      if(Array.isArray(msg.attachments) && msg.attachments.length){
        var files = document.createElement("div");
        files.className = "attachments-view";
        msg.attachments.forEach(function(a){
          var chip = document.createElement("span");
          chip.className = "file-chip";
          chip.textContent = a.name;
          files.appendChild(chip);
        });
        body.appendChild(files);
      }

      var bubble = document.createElement("div");
      bubble.className = "bubble";

      if(msg.role === "assistant"){
        if(msg.image){
          bubble.innerHTML =
            '<img class="generated-image" src="' + escapeHtml(msg.image) + '" alt="صورة مولدة">' +
            '<div class="image-actions">' +
              '<a href="' + escapeHtml(msg.image) + '" target="_blank" rel="noopener noreferrer">فتح الصورة</a>' +
              '<button type="button" data-image-download="' + escapeHtml(msg.image) + '">تنزيل</button>' +
            '</div>';
        }else if(msg.streaming){
          bubble.classList.add("streaming-plain");
          bubble.textContent = msg.text || "";
          var caret = document.createElement("span");
          caret.className = "typing-caret";
          bubble.appendChild(caret);
        }else{
          bubble.classList.remove("streaming-plain");
          bubble.innerHTML = renderMarkdown(msg.text || "");
        }
      }else{
        bubble.textContent = msg.text || "";
      }

      var actions = document.createElement("div");
      actions.className = "msg-actions";

      var copy = document.createElement("button");
      copy.textContent = "نسخ";
      copy.dataset.action = "copy";
      copy.dataset.id = msg.id;
      actions.appendChild(copy);

      if(msg.role === "user"){
        var edit = document.createElement("button");
        edit.textContent = "تعديل";
        edit.dataset.action = "edit";
        edit.dataset.id = msg.id;
        actions.appendChild(edit);
      }else if(!msg.streaming && !msg.image){
        var regen = document.createElement("button");
        regen.textContent = "إعادة";
        regen.dataset.action = "regenerate";
        regen.dataset.id = msg.id;
        actions.appendChild(regen);

        var speak = document.createElement("button");
        speak.textContent = "قراءة";
        speak.dataset.action = "speak";
        speak.dataset.id = msg.id;
        actions.appendChild(speak);
      }

      body.insertBefore(label,body.firstChild);
      body.appendChild(bubble);
      body.appendChild(actions);
      row.appendChild(avatar);
      row.appendChild(body);
      messagesEl.appendChild(row);

      return row;
    }

    function refreshMessage(msg){
      var old = messagesEl.querySelector('.message[data-id="' + msg.id + '"]');
      if(!old){
        appendMessageElement(msg);
        return;
      }

      var bubble = old.querySelector(".bubble");
      if(msg.role === "assistant"){
        if(msg.image){
          bubble.innerHTML =
            '<img class="generated-image" src="' + escapeHtml(msg.image) + '" alt="صورة مولدة">' +
            '<div class="image-actions">' +
              '<a href="' + escapeHtml(msg.image) + '" target="_blank" rel="noopener noreferrer">فتح الصورة</a>' +
              '<button type="button" data-image-download="' + escapeHtml(msg.image) + '">تنزيل</button>' +
            '</div>';
        }else if(msg.streaming){
          bubble.classList.add("streaming-plain");
          bubble.textContent = msg.text || "";
          var caret = document.createElement("span");
          caret.className = "typing-caret";
          bubble.appendChild(caret);
        }else{
          bubble.classList.remove("streaming-plain");
          bubble.innerHTML = renderMarkdown(msg.text || "");
        }
      }else{
        bubble.textContent = msg.text || "";
      }
    }

    function scrollBottom(smooth){
      requestAnimationFrame(function(){
        messagesEl.scrollTo({
          top:messagesEl.scrollHeight,
          behavior:smooth === false ? "auto" : "smooth"
        });
      });
    }

    function estimateTokens(text){
      var value = String(text || "");
      if(!value) return 0;
      // Conservative UI estimate for mixed Arabic/code text.
      return Math.ceil(value.length / 3.2);
    }

    function resizeInput(){
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight,150) + "px";
      var text = input.value || "";
      var lines = text ? text.split("\n").length : 1;
      var tokens = estimateTokens(text);
      inputUsage.textContent =
        text.length.toLocaleString("en-US") + " حرف · " +
        lines.toLocaleString("en-US") + " سطر · ~" +
        tokens.toLocaleString("en-US") + " token";
      inputUsage.classList.toggle("warning",text.length > 120000);
    }

    function setGenerating(value){
      generating = value;
      if(value){
        sendBtn.textContent = "■";
        sendBtn.classList.add("stop");
        sendBtn.setAttribute("aria-label","إيقاف");
        statusText.textContent = "جاري الرد...";
      }else{
        sendBtn.textContent = "↑";
        sendBtn.classList.remove("stop");
        sendBtn.setAttribute("aria-label","إرسال");
        statusText.textContent = navigator.onLine ? "جاهز" : "غير متصل";
      }
    }

    function showToast(text){
      toastEl.textContent = text;
      toastEl.classList.add("show");
      clearTimeout(showToast.timer);
      showToast.timer = setTimeout(function(){
        toastEl.classList.remove("show");
      },2600);
    }

    function buildHistory(chat,stopIndex){
      return chat.messages
        .slice(0,stopIndex)
        .filter(function(m){return !m.streaming && (m.role === "user" || m.role === "assistant");})
        .slice(-24)
        .map(function(m){
          return {role:m.role,content:String(m.text || "")};
        });
    }

    async function requestChatStream(payload){
      return fetch("/api/chat",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify(payload),
        signal:currentController.signal
      });
    }

    async function consumeResponse(response,assistantMsg){
      if(!response.body) throw new Error("تعذر بدء الرد.");

      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var lastSave = 0;
      var lastRender = 0;

      while(true){
        var part = await reader.read();
        if(part.done) break;

        var chunk = decoder.decode(part.value,{stream:true});
        if(chunk){
          assistantMsg.text += chunk;

          var now = Date.now();
          if(now - lastRender >= 70){
            refreshMessage(assistantMsg);
            scrollBottom(false);
            lastRender = now;
          }

          if(now - lastSave > 1000){
            saveState();
            lastSave = now;
          }
        }
      }

      refreshMessage(assistantMsg);
      scrollBottom(false);
    }

    async function getValidResponse(payload){
      var response = await requestChatStream(payload);
      var contentType = response.headers.get("content-type") || "";

      if(!response.ok || contentType.indexOf("application/json") !== -1){
        var errorData = {};
        try{
          errorData = await response.json();
        }catch(e){}

        if(
          payload.model &&
          payload.model !== "auto" &&
          !currentController.signal.aborted
        ){
          statusText.textContent = "إعادة المحاولة تلقائياً...";
          var fallbackPayload = Object.assign({},payload,{model:"auto"});

          response = await requestChatStream(fallbackPayload);
          contentType = response.headers.get("content-type") || "";

          if(!response.ok || contentType.indexOf("application/json") !== -1){
            var fallbackData = {};
            try{fallbackData = await response.json();}catch(e){}
            throw new Error(fallbackData.error || "تعذر إكمال الطلب.");
          }

          showToast("تم التحويل تلقائياً إلى نموذج متاح.");
          return {response:response,payload:fallbackPayload};
        }

        throw new Error(errorData.error || "تعذر إكمال الطلب.");
      }

      return {response:response,payload:payload};
    }

    async function streamRequest(payload,assistantMsg){
      currentController = new AbortController();

      var maxParts = Math.max(1,Math.min(8,Number(settings.maxContinuations || 6)));
      var part = 1;
      var activePayload = payload;

      while(part <= maxParts){
        var result = await getValidResponse(activePayload);
        await consumeResponse(result.response,assistantMsg);

        if(currentController.signal.aborted) break;

        var doneMarker = /\[\[ASHUR_DONE\]\]/g;
        var continueMarker = /\[\[ASHUR_CONTINUE\]\]/g;
        var hasDone = doneMarker.test(assistantMsg.text);
        var hasContinue = continueMarker.test(assistantMsg.text);

        assistantMsg.text = assistantMsg.text
          .replace(doneMarker,"")
          .replace(continueMarker,"")
          .trimEnd();

        refreshMessage(assistantMsg);

        if(!payload.long_output || hasDone) break;
        if(part >= maxParts) break;

        part += 1;
        statusText.textContent = "جاري تكملة الكود " + part + "/" + maxParts + "...";

        var continuationHistory = (payload.history || []).slice(-18);
        continuationHistory.push({
          role:"user",
          content:String(payload.text || "").slice(0,60000)
        });
        continuationHistory.push({
          role:"assistant",
          content:assistantMsg.text.slice(-70000)
        });

        activePayload = Object.assign({},result.payload,{
          text:"أكمل الرد السابق من آخر نقطة بدون إعادة المحتوى السابق.",
          history:continuationHistory,
          continuation:{
            part:part
          },
          attachments:[]
        });

        var fenceCount = (assistantMsg.text.match(/```/g) || []).length;
        var codeFenceOpen = fenceCount % 2 === 1;

        if(!hasContinue && !codeFenceOpen && assistantMsg.text.length < 8000){
          break;
        }
      }
    }

    function isImageRequest(text){
      var t = String(text || "").trim().toLowerCase();
      if(!t) return false;

      if(/^\/image\b/i.test(t) || /^\/img\b/i.test(t)) return true;

      if(/^(شلون|كيف|اشرح|علمني|ماهي|ما هي|ماهو|ما هو|شنو|طريقة|what|how|explain)\b/i.test(t)){
        return false;
      }

      var hasImageWord = /(صورة|صور|بوستر|ملصق|لوغو|لوجو|شعار|خلفية|wallpaper|image|picture|poster|logo)/i.test(t);
      var hasCreateVerb = /(انشئ|أنشئ|انشاء|إنشاء|اصنع|إصنع|سوي|سويلي|سوّي|صمم|صمّم|ارسم|ولد|ولّد|generate|create|draw|design|make)/i.test(t);

      return hasImageWord && hasCreateVerb;
    }

    function extractImagePrompt(text){
      var t = String(text || "").trim();

      t = t
        .replace(/^\/(image|img)\s*/i,"")
        .replace(/^(انشئ|أنشئ|انشاء|إنشاء|اصنع|إصنع|سوي|سويلي|سوّي|صمم|صمّم|ارسم|ولد|ولّد)\s*/i,"")
        .replace(/^(generate|create|draw|design|make)\s*/i,"")
        .replace(/^(لي\s*)?(صورة|صور|بوستر|ملصق|لوغو|لوجو|شعار|خلفية)\s*/i,"");

      return t.trim() || String(text || "").trim();
    }

    async function generateImageInChat(rawText, forcedModel){
      if(generating) return;

      var promptText = extractImagePrompt(rawText);
      if(!promptText){
        showToast("اكتب وصف الصورة أولاً.");
        return;
      }

      var chat = currentChat();
      var userMsg = {
        id:uid("msg"),
        role:"user",
        text:String(rawText || "").trim(),
        time:Date.now(),
        attachments:[]
      };

      var assistantMsg = {
        id:uid("msg"),
        role:"assistant",
        text:"جاري إنشاء الصورة...",
        time:Date.now(),
        attachments:[],
        streaming:true
      };

      chat.messages.push(userMsg);
      chat.messages.push(assistantMsg);

      if(chat.title === "محادثة جديدة"){
        chat.title = autoTitle("صورة: " + promptText);
      }

      input.value = "";
      pendingAttachments = [];
      renderAttachments();
      resizeInput();

      chat.updatedAt = Date.now();
      saveState();
      renderAll();
      setGenerating(true);
      statusText.textContent = "جاري إنشاء الصورة...";
      scrollBottom();

      currentController = new AbortController();

      try{
        var response = await fetch("/api/image",{
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({
            prompt:promptText,
            model:forcedModel || "auto"
          }),
          signal:currentController.signal
        });

        var data = {};
        try{data = await response.json();}catch(e){}

        if(!response.ok || !data.status || !data.image){
          throw new Error(data.error || "تعذر إنشاء الصورة.");
        }

        assistantMsg.streaming = false;
        assistantMsg.text = "";
        assistantMsg.image = data.image;
        assistantMsg.time = Date.now();

        chat.updatedAt = Date.now();
        saveState();
        renderAll();
        scrollBottom();

      }catch(error){
        if(error && error.name === "AbortError"){
          assistantMsg.streaming = false;
          assistantMsg.text = "تم إيقاف إنشاء الصورة.";
          showToast("تم إيقاف إنشاء الصورة.");
        }else{
          assistantMsg.streaming = false;
          assistantMsg.text = error.message || "تعذر إنشاء الصورة حالياً.";
          showToast(assistantMsg.text);
        }

        chat.updatedAt = Date.now();
        saveState();
        renderAll();

      }finally{
        currentController = null;
        setGenerating(false);
        setTimeout(function(){input.focus();},50);
      }
    }

    async function sendMessage(options){
      options = options || {};
      if(generating) return;

      var chat = currentChat();
      var text = options.text !== undefined ? String(options.text) : input.value.trim();
      var wireAttachments = options.attachments || pendingAttachments.slice();

      if(!text && !wireAttachments.length){
        showToast("اكتب رسالة أو أرفق ملف.");
        return;
      }

      if(!options.reuseUser && text.length > 120000){
        showToast("النص كبير جداً؛ قد يحتاج المصدر إلى وقت أطول لمعالجته.");
      }

      if(!options.reuseUser && text && !wireAttachments.length && isImageRequest(text)){
        await generateImageInChat(text);
        return;
      }

      var history;
      var userMsg;

      if(options.reuseUser){
        userMsg = options.reuseUser;
        var userIndex = chat.messages.findIndex(function(m){return m.id === userMsg.id;});
        history = buildHistory(chat,userIndex);
      }else{
        history = buildHistory(chat,chat.messages.length);

        userMsg = {
          id:uid("msg"),
          role:"user",
          text:text,
          time:Date.now(),
          attachments:wireAttachments.map(function(a){return {name:a.name,kind:a.kind};})
        };

        chat.messages.push(userMsg);

        if(chat.title === "محادثة جديدة"){
          chat.title = autoTitle(text || (wireAttachments[0] && wireAttachments[0].name));
        }

        input.value = "";
        pendingAttachments = [];
        renderAttachments();
        resizeInput();
      }

      var assistantMsg = {
        id:uid("msg"),
        role:"assistant",
        text:"",
        time:Date.now(),
        attachments:[],
        streaming:true
      };

      chat.messages.push(assistantMsg);
      chat.updatedAt = Date.now();
      saveState();
      renderAll();
      setGenerating(true);
      scrollBottom();

      try{
        await streamRequest({
          text:userMsg.text,
          mode:chat.mode || "general",
          temperature:Number(settings.temperature),
          long_output:(chat.mode === "coding") && settings.longOutput !== false,
          model:chat.model || settings.defaultModel || "auto",
          custom_instructions:settings.customInstructions || "",
          custom_knowledge:settings.customKnowledge || "",
          linked_context:buildLinkedContext(chat),
          conversation_id:chat.id,
          history:history,
          attachments:wireAttachments.map(function(a){
            return {
              kind:a.kind,
              name:a.name,
              data:a.data || "",
              text:a.text || ""
            };
          })
        },assistantMsg);

        assistantMsg.streaming = false;
        assistantMsg.time = Date.now();

        if(!assistantMsg.text.trim()){
          assistantMsg.text = "تعذر إنشاء الرد حالياً. حاول مرة ثانية.";
        }

      }catch(error){
        if(error && error.name === "AbortError"){
          assistantMsg.streaming = false;
          if(!assistantMsg.text.trim()){
            chat.messages = chat.messages.filter(function(m){return m.id !== assistantMsg.id;});
          }
          showToast("تم إيقاف الرد.");
        }else{
          assistantMsg.streaming = false;
          assistantMsg.text = assistantMsg.text || ("تعذر إكمال الطلب. " + (error.message || ""));
          showToast(error.message || "حدث خطأ مؤقت.");
        }
      }finally{
        currentController = null;
        chat.updatedAt = Date.now();
        saveState();
        setGenerating(false);
        renderAll();
        setTimeout(function(){input.focus();},50);
      }
    }

    function stopGeneration(){
      if(currentController){
        currentController.abort();
      }
    }

    async function copyText(text){
      try{
        await navigator.clipboard.writeText(String(text || ""));
        showToast("تم النسخ.");
      }catch(e){
        showToast("تعذر النسخ.");
      }
    }

    function handleMessageAction(action,id){
      var chat = currentChat();
      var index = chat.messages.findIndex(function(m){return m.id === id;});
      if(index < 0) return;
      var msg = chat.messages[index];

      if(action === "copy"){
        copyText(msg.text);
        return;
      }

      if(action === "speak"){
        if(!("speechSynthesis" in window)){
          showToast("القراءة الصوتية غير مدعومة على هذا الجهاز.");
          return;
        }
        speechSynthesis.cancel();
        var utter = new SpeechSynthesisUtterance(msg.text);
        utter.lang = "ar-IQ";
        speechSynthesis.speak(utter);
        return;
      }

      if(action === "edit" && msg.role === "user"){
        var edited = prompt("عدّل الرسالة",msg.text);
        if(edited === null || !edited.trim()) return;

        chat.messages = chat.messages.slice(0,index);
        saveState();
        renderAll();
        sendMessage({text:edited.trim(),attachments:[]});
        return;
      }

      if(action === "regenerate" && msg.role === "assistant"){
        if(generating) return;

        var userIndex = -1;
        for(var i=index-1;i>=0;i--){
          if(chat.messages[i].role === "user"){
            userIndex = i;
            break;
          }
        }
        if(userIndex < 0) return;

        var user = chat.messages[userIndex];
        chat.messages = chat.messages.slice(0,index);
        saveState();
        renderAll();
        sendMessage({reuseUser:user,attachments:[]});
      }
    }

    function openSidebar(){
      sidebar.classList.add("open");
      backdrop.classList.add("show");
    }

    function closeSidebar(){
      sidebar.classList.remove("open");
      backdrop.classList.remove("show");
    }

    function renderAttachments(){
      attachmentBar.innerHTML = "";
      pendingAttachments.forEach(function(item,index){
        var pill = document.createElement("div");
        pill.className = "attachment-pill";

        var name = document.createElement("span");
        name.textContent = item.name;

        var remove = document.createElement("button");
        remove.textContent = "×";
        remove.addEventListener("click",function(){
          pendingAttachments.splice(index,1);
          renderAttachments();
        });

        pill.appendChild(name);
        pill.appendChild(remove);
        attachmentBar.appendChild(pill);
      });
    }

    function fileToDataUrl(file){
      return new Promise(function(resolve,reject){
        var reader = new FileReader();
        reader.onload = function(){resolve(reader.result);};
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    function compressImage(file){
      return new Promise(function(resolve,reject){
        var img = new Image();
        var url = URL.createObjectURL(file);

        img.onload = function(){
          try{
            var maxSide = 1600;
            var scale = Math.min(1,maxSide/Math.max(img.width,img.height));
            var width = Math.max(1,Math.round(img.width*scale));
            var height = Math.max(1,Math.round(img.height*scale));
            var canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            var ctx = canvas.getContext("2d");
            ctx.drawImage(img,0,0,width,height);

            var quality = 0.86;
            var data = canvas.toDataURL("image/jpeg",quality);

            while(data.length > 2800000 && quality > 0.48){
              quality -= 0.1;
              data = canvas.toDataURL("image/jpeg",quality);
            }

            URL.revokeObjectURL(url);
            resolve(data);
          }catch(error){
            URL.revokeObjectURL(url);
            reject(error);
          }
        };

        img.onerror = function(){
          URL.revokeObjectURL(url);
          reject(new Error("تعذر قراءة الصورة"));
        };

        img.src = url;
      });
    }

    async function readPdf(file){
      if(!window.pdfjsLib) throw new Error("قارئ PDF لم يكتمل تحميله.");
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

      var buffer = await file.arrayBuffer();
      var pdf = await window.pdfjsLib.getDocument({data:buffer}).promise;
      var maxPages = Math.min(pdf.numPages,50);
      var result = "";

      for(var p=1;p<=maxPages;p++){
        var page = await pdf.getPage(p);
        var content = await page.getTextContent();
        result += "\n[صفحة " + p + "]\n" + content.items.map(function(x){return x.str;}).join(" ") + "\n";
        if(result.length > 100000) break;
      }

      return result.slice(0,100000);
    }

    async function handleFiles(files){
      var list = Array.from(files || []).slice(0,6);

      for(var i=0;i<list.length;i++){
        var file = list[i];

        try{
          if(file.type.indexOf("image/") === 0){
            showToast("جاري تجهيز الصورة...");
            pendingAttachments.push({
              kind:"image",
              name:file.name,
              data:await compressImage(file)
            });

          }else if(file.type === "application/pdf" || /\.pdf$/i.test(file.name)){
            if(file.size > 12000000){
              showToast("ملف PDF كبير جداً.");
              continue;
            }

            showToast("جاري قراءة PDF...");
            pendingAttachments.push({
              kind:"text",
              name:file.name,
              text:await readPdf(file)
            });

          }else{
            if(file.size > 4000000){
              showToast("الملف " + file.name + " كبير جداً.");
              continue;
            }

            var text = await file.text();
            pendingAttachments.push({
              kind:"text",
              name:file.name,
              text:text.slice(0,100000)
            });
          }
        }catch(e){
          showToast("تعذر قراءة " + file.name);
        }
      }

      fileInput.value = "";
      renderAttachments();
    }

    async function generateImage(){
      var prompt = imagePrompt.value.trim();

      if(!prompt){
        showToast("اكتب وصف الصورة أولاً.");
        return;
      }

      var selectedModel = imageModel.value || "auto";
      settings.imageModel = selectedModel;
      saveSettings();

      imageModal.classList.remove("open");
      imagePrompt.value = "";

      await generateImageInChat("إنشاء صورة: " + prompt, selectedModel);
    }

    function startVoice(){
      var Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

      if(!Recognition){
        showToast("الإدخال الصوتي غير مدعوم على هذا المتصفح.");
        return;
      }

      var recognition = new Recognition();
      recognition.lang = "ar-IQ";
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      statusText.textContent = "أستمع...";
      recognition.start();

      recognition.onresult = function(event){
        var transcript = event.results[0][0].transcript;
        input.value = (input.value ? input.value + " " : "") + transcript;
        resizeInput();
      };

      recognition.onerror = function(){
        showToast("تعذر التقاط الصوت.");
      };

      recognition.onend = function(){
        statusText.textContent = navigator.onLine ? "جاهز" : "غير متصل";
      };
    }

    function exportChat(){
      var chat = currentChat();

      if(!chat.messages.length){
        showToast("المحادثة فارغة.");
        return;
      }

      var md = "# " + chat.title + "\n\n";

      chat.messages.forEach(function(m){
        md += "## " + (m.role === "assistant" ? "Ashur AI" : "أنت") + "\n\n";
        md += String(m.text || "") + "\n\n";
      });

      var blob = new Blob([md],{type:"text/markdown;charset=utf-8"});
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = chat.title.replace(/[\\/:*?"<>|]/g,"_").slice(0,50) + ".md";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function(){URL.revokeObjectURL(url);},1000);
    }

    function openSettings(){
      applySettings();
      settingsModal.classList.add("open");
    }

    function closeSettings(){
      settingsModal.classList.remove("open");
    }

    document.getElementById("newChatBtn").addEventListener("click",createChat);
    document.getElementById("topNewBtn").addEventListener("click",createChat);
    document.getElementById("menuBtn").addEventListener("click",openSidebar);
    backdrop.addEventListener("click",closeSidebar);
    document.getElementById("settingsBtn").addEventListener("click",openSettings);
    document.getElementById("closeSettings").addEventListener("click",closeSettings);
    document.getElementById("exportBtn").addEventListener("click",exportChat);
    settingsModal.addEventListener("click",function(e){
      if(e.target === settingsModal) closeSettings();
    });

    linkChatsBtn.addEventListener("click",openLinkModal);
    document.getElementById("closeLinkModal").addEventListener("click",closeLinkModal);
    linkModal.addEventListener("click",function(e){
      if(e.target === linkModal) closeLinkModal();
    });
    clearLinksBtn.addEventListener("click",function(){
      var chat = currentChat();
      chat.linkedChatIds = [];
      saveState();
      renderLinkedChatList();
      renderLinkedContextStrip();
      showToast("تم إلغاء استدعاء المحادثات.");
    });

    chatSearch.addEventListener("input",renderChats);

    modeSelect.addEventListener("change",function(){
      var chat = currentChat();
      chat.mode = modeSelect.value;
      chat.updatedAt = Date.now();
      saveState();
      renderChats();
    });

    modelSelect.addEventListener("change",function(){
      var chat = currentChat();
      chat.model = modelSelect.value || "auto";
      settings.defaultModel = chat.model;
      chat.updatedAt = Date.now();
      saveSettings();
      saveState();
      renderChats();
    });

    input.addEventListener("input",resizeInput);
    input.addEventListener("keydown",function(e){
      if(e.key === "Enter" && !e.shiftKey && settings.enterToSend){
        e.preventDefault();
        sendMessage();
      }
    });

    sendBtn.addEventListener("click",function(){
      if(generating) stopGeneration();
      else sendMessage();
    });

    attachBtn.addEventListener("click",function(){fileInput.click();});
    fileInput.addEventListener("change",function(){handleFiles(fileInput.files);});
    voiceBtn.addEventListener("click",startVoice);
    imageBtn.addEventListener("click",function(){
      imageModel.value = settings.imageModel || "auto";
      imageModal.classList.add("open");
      setTimeout(function(){imagePrompt.focus();},50);
    });
    document.getElementById("closeImageModal").addEventListener("click",function(){
      imageModal.classList.remove("open");
    });
    imageModal.addEventListener("click",function(e){
      if(e.target === imageModal) imageModal.classList.remove("open");
    });
    generateImageBtn.addEventListener("click",generateImage);

    messagesEl.addEventListener("click",function(e){
      var actionBtn = e.target.closest("[data-action]");
      if(actionBtn){
        handleMessageAction(actionBtn.dataset.action,actionBtn.dataset.id);
        return;
      }

      var codeBtn = e.target.closest("[data-code-action]");
      if(codeBtn){
        var wrap = codeBtn.closest(".code-wrap");
        var code = wrap ? wrap.querySelector("code") : null;
        if(!wrap || !code) return;

        var action = codeBtn.dataset.codeAction;
        if(action === "copy"){
          copyText(code.textContent);
        }else if(action === "download"){
          var lang = wrap.dataset.lang || "txt";
          var blob = new Blob([code.textContent],{type:"text/plain;charset=utf-8"});
          var url = URL.createObjectURL(blob);
          var a = document.createElement("a");
          a.href = url;
          a.download = "ashur-code." + codeExtension(lang);
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function(){URL.revokeObjectURL(url);},1000);
        }else if(action === "expand"){
          var expanded = wrap.classList.toggle("expanded");
          codeBtn.textContent = expanded ? "تصغير" : "تكبير";
        }
        return;
      }

      var imageDownload = e.target.closest("[data-image-download]");
      if(imageDownload){
        var imageUrl = imageDownload.dataset.imageDownload;
        var a = document.createElement("a");
        a.href = imageUrl;
        a.download = "ashur-image.png";
        a.target = "_blank";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    });

    document.querySelectorAll(".suggestion").forEach(function(btn){
      btn.addEventListener("click",function(){
        if(btn.dataset.mode){
          var chat = currentChat();
          chat.mode = btn.dataset.mode;
          modeSelect.value = chat.mode;
          saveState();
        }

        if(btn.dataset.image === "1"){
          imagePrompt.value = btn.dataset.prompt || "";
          imageModel.value = settings.imageModel || "auto";
          imageModal.classList.add("open");
          setTimeout(function(){imagePrompt.focus();},50);
          return;
        }

        input.value = btn.dataset.prompt || "";
        resizeInput();
        input.focus();
      });
    });

    themeSetting.addEventListener("change",function(){
      settings.theme = themeSetting.value;
      saveSettings();
    });

    fontSetting.addEventListener("input",function(){
      settings.fontSize = Number(fontSetting.value);
      saveSettings();
    });

    tempSetting.addEventListener("change",function(){
      var value = Number(tempSetting.value);
      if(!Number.isFinite(value)) value = 0.7;
      settings.temperature = Math.max(0,Math.min(1.5,value));
      saveSettings();
    });

    enterSetting.addEventListener("change",function(){
      settings.enterToSend = enterSetting.checked;
      saveSettings();
    });

    longOutputSetting.addEventListener("change",function(){
      settings.longOutput = longOutputSetting.checked;
      saveSettings();
    });

    continuationSetting.addEventListener("change",function(){
      settings.maxContinuations = Number(continuationSetting.value) || 6;
      saveSettings();
    });

    customInstructions.addEventListener("input",function(){
      settings.customInstructions = customInstructions.value.slice(0,30000);
      saveSettings();
    });

    customKnowledge.addEventListener("input",function(){
      settings.customKnowledge = customKnowledge.value.slice(0,60000);
      saveSettings();
    });

    document.getElementById("clearAllBtn").addEventListener("click",async function(){
      if(!confirm("متأكد تريد حذف جميع المحادثات من هذا الجهاز؟")) return;

      clearTimeout(persistTimer);
      await clearStateDb();
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(META_KEY);
      localStorage.removeItem("ashur_ai_messages");

      state = loadState();
      activeId = state.activeId;
      await persistStateNow();

      closeSettings();
      renderAll();
      showToast("تم حذف المحادثات.");
    });

    window.addEventListener("online",function(){statusText.textContent = generating ? "جاري الرد..." : "جاهز";});
    window.addEventListener("offline",function(){statusText.textContent = "غير متصل";});

    window.addEventListener("beforeinstallprompt",function(e){
      e.preventDefault();
      deferredInstallPrompt = e;
      document.getElementById("installRow").style.display = "flex";
    });

    document.getElementById("installBtn").addEventListener("click",async function(){
      if(!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      try{await deferredInstallPrompt.userChoice;}catch(e){}
      deferredInstallPrompt = null;
      document.getElementById("installRow").style.display = "none";
    });

    if("serviceWorker" in navigator){
      var reloadingForUpdate = false;

      navigator.serviceWorker.addEventListener("controllerchange",function(){
        if(reloadingForUpdate) return;
        reloadingForUpdate = true;
        window.location.reload();
      });

      window.addEventListener("load",function(){
        navigator.serviceWorker.register("/sw.js").then(function(registration){
          registration.update().catch(function(){});

          registration.addEventListener("updatefound",function(){
            var worker = registration.installing;
            if(!worker) return;

            worker.addEventListener("statechange",function(){
              if(worker.state === "installed" && navigator.serviceWorker.controller){
                var banner = document.getElementById("updateBanner");
                if(banner) banner.classList.add("show");
              }
            });
          });

          var updateButton = document.getElementById("applyUpdateBtn");
          if(updateButton){
            updateButton.addEventListener("click",function(){
              var waiting = registration.waiting;
              if(waiting){
                waiting.postMessage({type:"SKIP_WAITING"});
              }else{
                window.location.reload();
              }
            });
          }
        }).catch(function(error){
          console.warn("Service worker registration failed",error);
        });
      });
    }

    async function bootstrap(){
      applySettings();
      statusText.textContent = "جاري تحميل المحادثات...";
      await hydrateStateFromDb();
      renderAll();
      resizeInput();
      statusText.textContent = navigator.onLine ? "جاهز" : "غير متصل";
      saveState();
    }

    bootstrap().catch(function(error){
      console.error("Bootstrap error",error);
      renderAll();
      resizeInput();
      statusText.textContent = "جاهز";
    });
  })();
