import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

Panel {
  id: root
  moduleName: "com.mwhuss.omarchy-hermes-api"
  ipcTarget: "com.mwhuss.omarchy-hermes-api"
  manageIpc: false

  property bool isConnected: false
  property var activeStreams: ({})
  property int activeStreamCount: 0
  readonly property bool isStreaming: activeStreamCount > 0
  readonly property bool isCurrentSessionStreaming: !!(selectedSessionId && activeStreams && activeStreams[selectedSessionId])
  property var sessionCache: ({})
  property bool isNearBottom: true
  property bool isRefreshing: false
  property bool isEditingTitle: false
  property bool isConfirmingDeleteSession: false
  property bool showSystemPromptInput: false
  property string sessionSystemPrompt: ""
  property string serverUrl: ""
  property string statusError: ""
  property string serverName: (typeof Quickshell !== "undefined" && typeof Quickshell.env === "function" && Quickshell.env("HERMES_API_SERVER_NAME")) || "Hermes"

  // Settings state
  property bool isSettingsOpen: false
  property var settingsEndpoints: []
  property int selectedEndpointIndex: 0
  property bool isConfirmingDeleteEndpoint: false
  property string settingsErrorMessage: ""
  property string settingsSuccessMessage: ""
  property bool maskEndpointApiKey: true

  // Session state
  property var sessions: []
  property var filteredSessions: []
  property string selectedSessionId: ""
  property string activeSessionTitle: "New Session"
  property string currentModel: "hermes-agent"
  property string searchQuery: ""
  property bool omarchyOnly: false
  property bool hasSelectedInitialSession: false

  // Active chat state
  property var messages: []
  property string currentStreamingContent: ""
  property var currentToolEvents: []

  function isSessionStreaming(sessionId) {
    return !!(sessionId && root.activeStreams && root.activeStreams[sessionId])
  }

  // Prompt history & draft state (scoped per session from active messages)
  function getCurrentSessionHistory() {
    var out = []
    for (var i = 0; i < root.messages.length; i++) {
      var m = root.messages[i]
      if (m && m.role === "user" && typeof m.content === "string") {
        var str = m.content.trim()
        if (str && (out.length === 0 || out[out.length - 1] !== str)) {
          out.push(str)
        }
      }
    }
    if (out.length > 50) {
      out = out.slice(out.length - 50)
    }
    return out
  }

  readonly property var promptHistory: getCurrentSessionHistory()
  property string promptDraft: ""
  property int promptHistoryIndex: -1

  readonly property color foreground: bar ? bar.barForeground : Color.foreground
  readonly property color background: Color.popups.background
  readonly property color border: Color.popups.border
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color accent: Color.accent
  readonly property color dimText: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.55)
  readonly property color subtleText: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.35)
  readonly property color cardBg: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.05)
  readonly property color cardHover: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.09)
  readonly property color userBubbleBg: Qt.rgba(accent.r, accent.g, accent.b, 0.16)
  readonly property color toolBadgeBg: Qt.rgba(245/255, 158/255, 11/255, 0.12)
  readonly property color toolBadgeBorder: Qt.rgba(245/255, 158/255, 11/255, 0.35)
  readonly property color toolBadgeText: "#F59E0B"
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property string scriptPath: {
    var u = Qt.resolvedUrl("bin/hermes-bridge.js").toString()
    return decodeURIComponent(u.replace(/^file:\/\//, ""))
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  Timer {
    id: refreshAnimationTimer
    interval: 800
    repeat: false
    onTriggered: root.isRefreshing = false
  }

  Timer {
    id: headerDeleteConfirmTimer
    interval: 5000
    running: root.isConfirmingDeleteSession
    onTriggered: root.isConfirmingDeleteSession = false
  }

  Timer {
    id: settingsSuccessTimer
    interval: 3500
    repeat: false
    onTriggered: root.settingsSuccessMessage = ""
  }

  Timer {
    id: endpointDeleteConfirmTimer
    interval: 5000
    running: root.isConfirmingDeleteEndpoint
    onTriggered: root.isConfirmingDeleteEndpoint = false
  }

  Timer {
    id: scrollSnapTimer
    interval: 50
    repeat: false
    onTriggered: {
      if (chatFlick) {
        chatFlick.contentY = Math.max(0, chatFlick.contentHeight - chatFlick.height)
      }
    }
  }

  Timer {
    id: fastPollTimer
    interval: 3000
    running: root.opened
    repeat: true
    onTriggered: {
      root.refreshSessions()
      if (root.selectedSessionId && !root.isCurrentSessionStreaming && !getSessionProc.running) {
        getSessionProc.command = ["node", root.scriptPath, "get-session", root.selectedSessionId]
        getSessionProc.running = true
      }
    }
  }

  function triggerRefresh() {
    root.isRefreshing = true
    refreshAnimationTimer.restart()
    root.checkStatus()
    root.refreshSessions()
    if (root.selectedSessionId) {
      root.selectSession(root.selectedSessionId)
    }
  }

  onOpenedChanged: {
    if (opened) {
      root.isConfirmingDeleteSession = false
      root.isConfirmingDeleteEndpoint = false
      root.settingsErrorMessage = ""
      root.settingsSuccessMessage = ""
      triggerRefresh()
      root.loadSettings()
      Qt.callLater(function() {
        if (!root.isSettingsOpen && promptInput) promptInput.forceActiveFocus()
      })
    }
  }

  function checkStatus() {
    if (statusProc.running) return
    statusProc.command = ["node", root.scriptPath, "status"]
    statusProc.running = true
  }

  function parseStatus(text) {
    if (!text || String(text).trim() === "") return
    try {
      var res = JSON.parse(String(text).trim())
      root.isConnected = res.connected === true
      root.serverUrl = res.baseUrl || ""
      if (res.models && res.models.length > 0) {
        root.currentModel = res.models[0]
      }
      if (res.serverName && String(res.serverName).trim()) {
        root.serverName = String(res.serverName).trim()
      }
      root.statusError = res.error || ""
    } catch (e) {
      root.isConnected = false
    }
  }

  function refreshSessions() {
    if (listSessionsProc.running) return
    listSessionsProc.command = ["node", root.scriptPath, "list-sessions"]
    listSessionsProc.running = true
  }

  function parseSessions(text) {
    if (!text || String(text).trim() === "") return
    try {
      var res = JSON.parse(String(text).trim())
      if (res.success && Array.isArray(res.sessions)) {
        var serverList = res.sessions
        var merged = []
        var serverMap = {}
        for (var i = 0; i < serverList.length; i++) {
          serverMap[serverList[i].id] = serverList[i]
        }

        // Keep any active streams that might not be on server yet
        var activeIds = Object.keys(root.activeStreams || {})
        for (var a = 0; a < activeIds.length; a++) {
          var aid = activeIds[a]
          if (!serverMap[aid]) {
            var cachedActive = root.sessionCache[aid] || {}
            merged.push({
              id: aid,
              title: cachedActive.title || "New Session",
              created_at: cachedActive.created_at || new Date().toISOString(),
              updated_at: cachedActive.updated_at || new Date().toISOString(),
              source: "omarchy-bar",
              message_count: (cachedActive.messages ? cachedActive.messages.length : 0),
              model: root.currentModel
            })
          }
        }

        // Add server sessions
        for (var s = 0; s < serverList.length; s++) {
          var sItem = Object.assign({}, serverList[s])
          if (root.sessionCache[sItem.id]) {
            var c = root.sessionCache[sItem.id]
            if (c.title && !c.title.startsWith("Session api-")) sItem.title = c.title
            if (c.updated_at && new Date(c.updated_at) > new Date(sItem.updated_at)) {
              sItem.updated_at = c.updated_at
            }
          }
          merged.push(sItem)
        }

        // Sort by updated_at descending (Recency Ordering)
        merged.sort(function(x, y) {
          return new Date(y.updated_at).getTime() - new Date(x.updated_at).getTime()
        })

        root.sessions = merged

        if (!root.hasSelectedInitialSession && merged.length > 0) {
          root.hasSelectedInitialSession = true
          root.selectSession(merged[0].id)
        }
      }
    } catch (e) {
      console.warn("hermes-bridge/list-sessions error:", e)
    }
  }

  function selectSession(sessionId) {
    root.hasSelectedInitialSession = true
    if (selectedSessionId === sessionId) return
    isEditingTitle = false
    isConfirmingDeleteSession = false
    showSystemPromptInput = false
    sessionSystemPrompt = ""
    promptDraft = ""
    promptHistoryIndex = -1
    if (promptInput) promptInput.text = ""
    selectedSessionId = sessionId
    
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i].id === sessionId) {
        activeSessionTitle = sessions[i].title || "Session"
        break
      }
    }

    // Instant tab switch from sessionCache (0ms latency, no empty flicker!)
    if (root.sessionCache[sessionId] && Array.isArray(root.sessionCache[sessionId].messages)) {
      root.messages = root.sessionCache[sessionId].messages
    } else {
      root.messages = []
    }

    // Restore active in-flight stream state for this session if streaming
    if (root.activeStreams && root.activeStreams[sessionId]) {
      root.currentStreamingContent = root.activeStreams[sessionId].streamingContent || ""
      root.currentToolEvents = root.activeStreams[sessionId].toolEvents || []
    } else {
      root.currentStreamingContent = ""
      root.currentToolEvents = []
    }

    root.scrollToBottomInstantly()

    if (getSessionProc.running) {
      getSessionProc.running = false
    }
    getSessionProc.command = ["node", root.scriptPath, "get-session", sessionId]
    getSessionProc.running = true

    Qt.callLater(function() {
      if (promptInput) promptInput.forceActiveFocus()
    })
  }

  function parseSessionDetail(text) {
    if (!text || String(text).trim() === "") return
    try {
      var res = JSON.parse(String(text).trim())
      if (res.success && res.session) {
        var sid = res.session.id || root.selectedSessionId
        var serverMsgs = res.session.messages || []

        var cached = root.sessionCache[sid] || {}
        var oldMsgs = cached.messages || []

        // If local is currently streaming, don't overwrite local in-flight stream buffer
        if (!root.isSessionStreaming(sid)) {
          cached.messages = serverMsgs
          if (res.session.title && !res.session.title.startsWith("Session api-")) {
            cached.title = res.session.title
          }
          var updatedCache = Object.assign({}, root.sessionCache)
          updatedCache[sid] = cached
          root.sessionCache = updatedCache

          if (root.selectedSessionId === sid) {
            // Only update root.messages if there is an actual difference to avoid layout churn
            if (oldMsgs.length !== serverMsgs.length || JSON.stringify(oldMsgs) !== JSON.stringify(serverMsgs)) {
              root.messages = serverMsgs
              if (res.session.title && !res.session.title.startsWith("Session api-")) {
                root.activeSessionTitle = res.session.title
              }
              if (root.isNearBottom) {
                root.scrollToBottomInstantly()
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn("hermes-bridge/get-session parse error:", e)
    }
  }

  function saveSessionTitle(newTitle) {
    var trimmed = String(newTitle || "").trim()
    if (!trimmed || !selectedSessionId) {
      isEditingTitle = false
      return
    }

    activeSessionTitle = trimmed
    isEditingTitle = false

    var updatedSessions = sessions.slice()
    for (var i = 0; i < updatedSessions.length; i++) {
      if (updatedSessions[i].id === selectedSessionId) {
        updatedSessions[i] = Object.assign({}, updatedSessions[i], { title: trimmed })
        break
      }
    }
    sessions = updatedSessions

    if (root.sessionCache[selectedSessionId]) {
      var c = Object.assign({}, root.sessionCache[selectedSessionId], { title: trimmed })
      var uc = Object.assign({}, root.sessionCache)
      uc[selectedSessionId] = c
      root.sessionCache = uc
    }

    renameSessionProc.command = ["node", root.scriptPath, "rename-session", selectedSessionId, trimmed]
    renameSessionProc.running = true
  }

  function startNewSession() {
    root.hasSelectedInitialSession = true
    isEditingTitle = false
    isConfirmingDeleteSession = false
    showSystemPromptInput = false
    sessionSystemPrompt = ""
    selectedSessionId = ""
    activeSessionTitle = "New Session"
    messages = []
    currentStreamingContent = ""
    currentToolEvents = []
    promptDraft = ""
    promptHistoryIndex = -1
    Qt.callLater(function() {
      if (promptInput) {
        promptInput.text = ""
        promptInput.forceActiveFocus()
      }
    })
  }

  function navigatePromptHistory(goBack) {
    if (!promptInput || root.promptHistory.length === 0) return false

    if (goBack) {
      if (root.promptHistoryIndex === -1) {
        root.promptDraft = promptInput.text
        root.promptHistoryIndex = root.promptHistory.length - 1
      } else if (root.promptHistoryIndex > 0) {
        root.promptHistoryIndex--
      } else {
        return true
      }
      promptInput.text = root.promptHistory[root.promptHistoryIndex]
      promptInput.cursorPosition = promptInput.text.length
      return true
    } else {
      if (root.promptHistoryIndex === -1) {
        return true
      } else if (root.promptHistoryIndex < root.promptHistory.length - 1) {
        root.promptHistoryIndex++
        promptInput.text = root.promptHistory[root.promptHistoryIndex]
        promptInput.cursorPosition = promptInput.text.length
      } else {
        root.promptHistoryIndex = -1
        promptInput.text = root.promptDraft
        promptInput.cursorPosition = promptInput.text.length
      }
      return true
    }
  }

  function deleteSession(sessionId) {
    if (root.isSessionStreaming(sessionId)) {
      root.cancelStreaming(sessionId)
    }
    isConfirmingDeleteSession = false
    var remaining = sessions.filter(function(s) { return s.id !== sessionId })
    sessions = remaining

    var updatedCache = Object.assign({}, root.sessionCache)
    delete updatedCache[sessionId]
    root.sessionCache = updatedCache

    if (selectedSessionId === sessionId) {
      if (remaining.length > 0) {
        root.selectSession(remaining[0].id)
      } else {
        root.startNewSession()
      }
    }
    deleteSessionProc.command = ["node", root.scriptPath, "delete-session", sessionId]
    deleteSessionProc.running = true
  }

  function promoteSessionToTop(sessionId, title, lastMessage) {
    var list = root.sessions.slice()
    var foundIdx = -1
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === sessionId) {
        foundIdx = i
        break
      }
    }
    var item
    if (foundIdx >= 0) {
      item = Object.assign({}, list[foundIdx], {
        updated_at: new Date().toISOString()
      })
      if (title && !title.startsWith("Session api-")) item.title = title
      list.splice(foundIdx, 1)
      list.unshift(item)
    } else {
      var displayTitle = title
      if (!displayTitle || displayTitle === "New Session" || displayTitle.startsWith("Session api-")) {
        displayTitle = lastMessage ? (lastMessage.length > 32 ? (lastMessage.slice(0, 32) + "...") : lastMessage) : "New Session"
      }
      item = {
        id: sessionId,
        title: displayTitle,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        source: "omarchy-bar",
        message_count: 1,
        model: root.currentModel
      }
      list.unshift(item)
    }
    root.sessions = list
  }

  function scrollToBottomInstantly() {
    root.isNearBottom = true
    Qt.callLater(function() {
      if (chatFlick) {
        chatFlick.contentY = Math.max(0, chatFlick.contentHeight - chatFlick.height)
      }
    })
    scrollSnapTimer.restart()
  }

  function autoScrollFollow() {
    if (!chatFlick) return
    var dist = (chatFlick.contentHeight - chatFlick.height) - chatFlick.contentY
    if (dist <= 80 || root.isNearBottom) {
      chatFlick.contentY = Math.max(0, chatFlick.contentHeight - chatFlick.height)
    }
  }

  function sendCurrentMessage() {
    if (!promptInput) return
    var text = String(promptInput.text || "").trim()
    if (!text) return

    // If currently selected session is already generating, do not allow sending another in this session
    if (root.selectedSessionId && root.isSessionStreaming(root.selectedSessionId)) return

    var targetSessionId = root.selectedSessionId
    var isNewSession = !targetSessionId

    if (isNewSession) {
      var timestamp = Date.now().toString(36)
      var rand = Math.random().toString(36).substring(2, 6)
      targetSessionId = "api-" + timestamp + "-" + rand
      root.selectedSessionId = targetSessionId
      root.activeSessionTitle = text.length > 32 ? (text.slice(0, 32) + "...") : text
    }

    root.promptDraft = ""
    root.promptHistoryIndex = -1
    promptInput.text = ""

    var currentMsgs = (root.sessionCache[targetSessionId] && root.sessionCache[targetSessionId].messages)
      ? root.sessionCache[targetSessionId].messages.slice()
      : (isNewSession ? [] : root.messages.slice())

    currentMsgs.push({ role: "user", content: text, timestamp: new Date().toISOString() })

    var cached = Object.assign({}, root.sessionCache[targetSessionId] || {}, {
      messages: currentMsgs,
      title: root.activeSessionTitle || text,
      updated_at: new Date().toISOString()
    })
    var updatedCache = Object.assign({}, root.sessionCache)
    updatedCache[targetSessionId] = cached
    root.sessionCache = updatedCache

    if (root.selectedSessionId === targetSessionId) {
      root.messages = currentMsgs
      root.currentStreamingContent = ""
      root.currentToolEvents = []
    }

    root.promoteSessionToTop(targetSessionId, root.activeSessionTitle, text)

    var args = [
      "node",
      root.scriptPath,
      "stream-chat",
      "--prompt", text,
      "--model", root.currentModel,
      "--session", targetSessionId
    ]

    if (sessionSystemPrompt && sessionSystemPrompt.trim() !== "") {
      args.push("--system", sessionSystemPrompt.trim())
    }

    var historySlice = currentMsgs.slice(0, -1).map(function(m) {
      return { role: m.role, content: m.content }
    })
    args.push("--history", JSON.stringify(historySlice))

    root.startSessionStreamProcess(targetSessionId, args)

    root.scrollToBottomInstantly()
  }

  function startSessionStreamProcess(targetSessionId, args) {
    if (!targetSessionId) return
    var procObj = streamProcessComponent.createObject(root, {
      targetSessionId: targetSessionId,
      command: args,
      running: true
    })
    var updated = Object.assign({}, root.activeStreams)
    updated[targetSessionId] = {
      proc: procObj,
      streamingContent: "",
      toolEvents: [],
      startedAt: Date.now()
    }
    root.activeStreams = updated
    root.activeStreamCount = Object.keys(updated).length
  }

  function handleStreamEvent(targetSessionId, line) {
    var trimmed = String(line || "").trim()
    if (!trimmed) return
    try {
      var ev = JSON.parse(trimmed)
      var streamInfo = root.activeStreams[targetSessionId]
      if (!streamInfo) return

      if (ev.type === "delta") {
        streamInfo.streamingContent = (streamInfo.streamingContent || "") + (ev.content || "")
        if (root.selectedSessionId === targetSessionId) {
          root.currentStreamingContent = streamInfo.streamingContent
          root.autoScrollFollow()
        }
      } else if (ev.type === "tool_progress") {
        var tools = (streamInfo.toolEvents || []).slice()
        var foundIdx = -1
        for (var t = 0; t < tools.length; t++) {
          if (ev.id && tools[t].id === ev.id) {
            foundIdx = t
            break
          } else if (!ev.id && tools[t].tool === ev.tool) {
            foundIdx = t
            break
          }
        }
        if (foundIdx >= 0) {
          var updatedEv = Object.assign({}, tools[foundIdx], ev)
          if (!updatedEv.label && tools[foundIdx].label) updatedEv.label = tools[foundIdx].label
          if (!updatedEv.emoji && tools[foundIdx].emoji) updatedEv.emoji = tools[foundIdx].emoji
          tools[foundIdx] = updatedEv
        } else {
          tools.push(ev)
        }
        streamInfo.toolEvents = tools
        if (root.selectedSessionId === targetSessionId) {
          root.currentToolEvents = tools
          root.autoScrollFollow()
        }
      } else if (ev.type === "done") {
        var replyText = ev.full_text || streamInfo.streamingContent || ""
        root.finishSessionStream(targetSessionId, replyText, false, streamInfo.toolEvents)
      } else if (ev.type === "error") {
        root.finishSessionStream(targetSessionId, ev.error || "Generation error", true, streamInfo.toolEvents)
      }
    } catch (e) {
      // Partial chunk
    }
  }

  function finishSessionStream(targetSessionId, replyText, isError, toolEvents) {
    var streamInfo = root.activeStreams[targetSessionId]
    if (streamInfo && streamInfo.proc) {
      try {
        streamInfo.proc.running = false
        streamInfo.proc.destroy()
      } catch (e) {}
    }

    var updatedActive = Object.assign({}, root.activeStreams)
    delete updatedActive[targetSessionId]
    root.activeStreams = updatedActive
    root.activeStreamCount = Object.keys(updatedActive).length

    var cached = root.sessionCache[targetSessionId] || {}
    var msgs = (cached.messages || []).slice()
    msgs.push({
      role: "assistant",
      content: isError ? ("⚠️ Error: " + replyText) : replyText,
      timestamp: new Date().toISOString(),
      tool_events: (toolEvents || []).slice()
    })
    cached.messages = msgs
    cached.updated_at = new Date().toISOString()
    var updatedCache = Object.assign({}, root.sessionCache)
    updatedCache[targetSessionId] = cached
    root.sessionCache = updatedCache

    if (root.selectedSessionId === targetSessionId) {
      root.messages = msgs
      root.currentStreamingContent = ""
      root.currentToolEvents = []
      root.scrollToBottomInstantly()
    }

    root.promoteSessionToTop(targetSessionId, cached.title || root.activeSessionTitle, replyText)

    var isCurrentlyViewing = root.opened && (root.selectedSessionId === targetSessionId)
    if (!isCurrentlyViewing) {
      root.postCompletionNotification(replyText, isError, targetSessionId)
    }

    root.refreshSessions()
  }

  function cancelStreaming(sessionId) {
    var sid = sessionId || root.selectedSessionId
    if (!sid) return
    var streamInfo = root.activeStreams[sid]
    if (!streamInfo) return

    if (streamInfo.proc) {
      try {
        streamInfo.proc.running = false
        streamInfo.proc.destroy()
      } catch (e) {}
    }

    var partialContent = streamInfo.streamingContent || ""
    var tools = streamInfo.toolEvents || []

    var updatedActive = Object.assign({}, root.activeStreams)
    delete updatedActive[sid]
    root.activeStreams = updatedActive
    root.activeStreamCount = Object.keys(updatedActive).length

    if (partialContent) {
      var cached = root.sessionCache[sid] || {}
      var msgs = (cached.messages || []).slice()
      msgs.push({
        role: "assistant",
        content: partialContent,
        timestamp: new Date().toISOString(),
        tool_events: tools
      })
      cached.messages = msgs
      var updatedCache = Object.assign({}, root.sessionCache)
      updatedCache[sid] = cached
      root.sessionCache = updatedCache

      if (root.selectedSessionId === sid) {
        root.messages = msgs
      }
    }

    if (root.selectedSessionId === sid) {
      root.currentStreamingContent = ""
      root.currentToolEvents = []
    }
  }

  function updateFilteredSessions() {
    var q = (searchQuery || "").toLowerCase()
    var out = []
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i]
      if (omarchyOnly && s.source !== "omarchy-bar" && s.source !== "api-server") {
        continue
      }
      if (q) {
        var t = (s.title || "").toLowerCase()
        if (t.indexOf(q) === -1 && String(s.id).indexOf(q) === -1) {
          continue
        }
      }
      out.push(s)
    }
    filteredSessions = out
  }

  onSessionsChanged: updateFilteredSessions()
  onSearchQueryChanged: updateFilteredSessions()
  onOmarchyOnlyChanged: updateFilteredSessions()

  function formatTime(isoStr) {
    if (!isoStr) return ""
    try {
      var d = new Date(isoStr)
      if (isNaN(d.getTime())) return ""
      return Qt.formatTime(d, "hh:mm AP")
    } catch (e) {
      return ""
    }
  }

  function postCompletionNotification(content, isError, sessionId) {
    var notifyOnComp = root.setting("notifyOnComplete", true)
    var notifyOnErr = root.setting("notifyOnError", true)

    if (isError) {
      if (!notifyOnErr) {
        console.log("hermes-bridge/notify: skipped due to notifyOnError=false")
        return
      }
    } else {
      if (!notifyOnComp) {
        console.log("hermes-bridge/notify: skipped due to notifyOnComplete=false")
        return
      }
    }

    var targetId = sessionId || root.selectedSessionId || ""
    var targetTitle = ""
    for (var i = 0; i < root.sessions.length; i++) {
      if (root.sessions[i].id === targetId) {
        targetTitle = root.sessions[i].title
        break
      }
    }
    if (!targetTitle) {
      targetTitle = (root.selectedSessionId === targetId ? root.activeSessionTitle : "") || root.serverName
    }

    var title = isError ? (targetTitle + " - Error") : targetTitle

    // Format a concise preview by cleaning markdown syntax
    var preview = String(content || "").trim()
    preview = preview.replace(/```[\s\S]*?```/g, "[Code]")
    preview = preview.replace(/`([^`]+)`/g, "$1")
    preview = preview.replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    preview = preview.replace(/[*_~>#]/g, "")
    preview = preview.replace(/\s+/g, " ").trim()

    if (preview.length > 140) {
      preview = preview.slice(0, 137) + "..."
    }
    if (!preview) {
      preview = isError ? "An error occurred." : "Response completed."
    }

    var glyph = isError ? "\u{f015a}" : root.setting("icon", "\u{f06d3}")
    var urgency = isError ? "critical" : "normal"

    var execCmd = ["quickshell", "-p", "/usr/share/omarchy/shell", "ipc", "call", "com.mwhuss.omarchy-hermes-api", "openSession", targetId]

    var bashArgs = [
      "bash", "-lc",
      'if command -v omarchy-notification-send >/dev/null 2>&1; then ' +
      '  omarchy-notification-send --app-name "$1" -u "$2" -g "$3" "$4" "$5" --exec "${@:6}"; ' +
      'else ' +
      '  notify-send -a "$1" -u "$2" "$4" "$5"; ' +
      'fi',
      "bash",
      root.serverName,
      urgency,
      glyph,
      title,
      preview
    ].concat(execCmd)

    console.log("hermes-bridge/notify: dispatching notification: " + title + " -> " + preview + " (sessionId=" + targetId + ")")
    Quickshell.execDetached(bashArgs)
  }

  IpcHandler {
    target: "com.mwhuss.omarchy-hermes-api"
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function openSession(sessionId: string): string {
      root.open()
      if (sessionId && String(sessionId).trim() !== "") {
        var cleanId = String(sessionId).trim()
        if (root.selectedSessionId !== cleanId) {
          root.selectSession(cleanId)
        } else {
          if (!getSessionProc.running) {
            getSessionProc.command = ["node", root.scriptPath, "get-session", cleanId]
            getSessionProc.running = true
          }
        }
      }
      return "ok"
    }
    function syncSession(sessionId: string): string {
      root.refreshSessions()
      var cleanId = sessionId ? String(sessionId).trim() : ""
      if (cleanId && root.selectedSessionId === cleanId) {
        if (!getSessionProc.running) {
          getSessionProc.command = ["node", root.scriptPath, "get-session", cleanId]
          getSessionProc.running = true
        }
      }
      return "ok"
    }
    function testNotify(): string {
      root.postCompletionNotification("Test response from " + root.serverName, false, root.selectedSessionId)
      return "ok"
    }
  }

  // ------------------------------------------------------------- Settings Management

  function loadSettings() {
    root.settingsErrorMessage = ""
    root.settingsSuccessMessage = ""
    root.isConfirmingDeleteEndpoint = false
    getSettingsProc.command = ["node", root.scriptPath, "get-settings"]
    getSettingsProc.running = true
  }

  function parseSettings(text) {
    if (!text || String(text).trim() === "") return
    try {
      var data = JSON.parse(text)
      if (data && data.success && data.settings && Array.isArray(data.settings.endpoints)) {
        var eps = JSON.parse(JSON.stringify(data.settings.endpoints))
        root.settingsEndpoints = eps
        if (root.selectedEndpointIndex >= eps.length) {
          root.selectedEndpointIndex = Math.max(0, eps.length - 1)
        }
      }
    } catch (e) {
      console.warn("hermes-bridge/get-settings parse error:", e)
    }
  }

  function parseSaveSettingsResult(text) {
    if (!text || String(text).trim() === "") return
    try {
      var data = JSON.parse(text)
      if (data && data.success) {
        root.settingsErrorMessage = ""
        root.settingsSuccessMessage = "Settings saved successfully"
        settingsSuccessTimer.restart()
        if (data.settings && Array.isArray(data.settings.endpoints)) {
          root.settingsEndpoints = JSON.parse(JSON.stringify(data.settings.endpoints))
          if (root.settingsEndpoints.length > 0) {
            var activeEp = root.settingsEndpoints[0]
            root.serverName = activeEp.name || "Hermes"
          }
        }
        root.triggerRefresh()
      } else {
        root.settingsErrorMessage = (data && data.error) ? data.error : "Failed to save settings"
      }
    } catch (e) {
      root.settingsErrorMessage = "Error parsing save response: " + e
    }
  }

  function updateEndpointField(index, field, value) {
    if (index < 0 || index >= root.settingsEndpoints.length) return
    var eps = JSON.parse(JSON.stringify(root.settingsEndpoints))
    eps[index][field] = value
    root.settingsEndpoints = eps
  }

  function addEndpoint() {
    var eps = JSON.parse(JSON.stringify(root.settingsEndpoints))
    var newEp = {
      id: "endpoint-" + Date.now(),
      name: "New Endpoint",
      url: "http://127.0.0.1",
      port: 8642,
      apiKey: "",
      profiles: [
        { name: "default", apiKey: "" }
      ]
    }
    eps.push(newEp)
    root.settingsEndpoints = eps
    root.selectedEndpointIndex = eps.length - 1
    root.isConfirmingDeleteEndpoint = false
    root.settingsErrorMessage = ""
  }

  function deleteCurrentEndpoint() {
    if (root.selectedEndpointIndex < 0 || root.selectedEndpointIndex >= root.settingsEndpoints.length) return
    var eps = JSON.parse(JSON.stringify(root.settingsEndpoints))
    eps.splice(root.selectedEndpointIndex, 1)
    root.settingsEndpoints = eps
    root.selectedEndpointIndex = Math.max(0, Math.min(root.selectedEndpointIndex, eps.length - 1))
    root.isConfirmingDeleteEndpoint = false
    root.settingsErrorMessage = ""
  }

  function addProfileToCurrentEndpoint() {
    if (root.selectedEndpointIndex < 0 || root.selectedEndpointIndex >= root.settingsEndpoints.length) return
    var eps = JSON.parse(JSON.stringify(root.settingsEndpoints))
    var ep = eps[root.selectedEndpointIndex]
    if (!ep.profiles) ep.profiles = []
    ep.profiles.push({
      name: "profile-" + (ep.profiles.length + 1),
      apiKey: ""
    })
    root.settingsEndpoints = eps
    root.settingsErrorMessage = ""
  }

  function updateProfileField(profIndex, field, value) {
    if (root.selectedEndpointIndex < 0 || root.selectedEndpointIndex >= root.settingsEndpoints.length) return
    var eps = JSON.parse(JSON.stringify(root.settingsEndpoints))
    var ep = eps[root.selectedEndpointIndex]
    if (!ep.profiles || profIndex < 0 || profIndex >= ep.profiles.length) return
    ep.profiles[profIndex][field] = value
    root.settingsEndpoints = eps
  }

  function deleteProfileFromCurrentEndpoint(profIndex) {
    if (root.selectedEndpointIndex < 0 || root.selectedEndpointIndex >= root.settingsEndpoints.length) return
    var eps = JSON.parse(JSON.stringify(root.settingsEndpoints))
    var ep = eps[root.selectedEndpointIndex]
    if (!ep.profiles || profIndex < 0 || profIndex >= ep.profiles.length) return
    ep.profiles.splice(profIndex, 1)
    root.settingsEndpoints = eps
    root.settingsErrorMessage = ""
  }

  function validateAndSaveSettings() {
    root.settingsErrorMessage = ""
    if (!root.settingsEndpoints || root.settingsEndpoints.length === 0) {
      root.settingsErrorMessage = "At least one endpoint is required."
      return
    }

    var eps = JSON.parse(JSON.stringify(root.settingsEndpoints))
    for (var i = 0; i < eps.length; i++) {
      var ep = eps[i]
      var name = (ep.name || "").trim()
      if (!name) {
        root.settingsErrorMessage = "Endpoint #" + (i + 1) + " display name cannot be empty."
        return
      }
      var url = (ep.url || "").trim()
      if (!url) {
        root.settingsErrorMessage = "Endpoint '" + name + "' URL cannot be empty."
        return
      }
      var port = parseInt(ep.port, 10)
      if (isNaN(port) || port < 1 || port > 65535) {
        root.settingsErrorMessage = "Endpoint '" + name + "' port must be between 1 and 65535."
        return
      }
      if (ep.profiles) {
        for (var j = 0; j < ep.profiles.length; j++) {
          var profName = (ep.profiles[j].name || "").trim()
          if (!profName) {
            root.settingsErrorMessage = "Profile #" + (j + 1) + " in endpoint '" + name + "' must have a name."
            return
          }
        }
      }
    }

    saveSettingsProc.command = ["node", root.scriptPath, "save-settings", JSON.stringify({ endpoints: eps })]
    saveSettingsProc.running = true
  }

  // ------------------------------------------------------------- Processes

  Process {
    id: statusProc
    running: false
    command: []
    stdout: StdioCollector {
      id: statusStdout
      waitForEnd: true
      onStreamFinished: root.parseStatus(statusStdout.text)
    }
    stderr: StdioCollector {
      id: statusStderr
      waitForEnd: true
      onStreamFinished: {
        if (statusStderr.text && statusStderr.text.trim()) console.warn("hermes-bridge/status stderr:", statusStderr.text)
      }
    }
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        root.isConnected = false
        root.statusError = String(statusStderr.text || "").trim() || "Status exit code " + exitCode
      }
    }
  }

  Process {
    id: listSessionsProc
    running: false
    command: []
    stdout: StdioCollector {
      id: listStdout
      waitForEnd: true
      onStreamFinished: root.parseSessions(listStdout.text)
    }
    stderr: StdioCollector {
      id: listStderr
      waitForEnd: true
      onStreamFinished: {
        if (listStderr.text && listStderr.text.trim()) console.warn("hermes-bridge/list-sessions stderr:", listStderr.text)
      }
    }
  }

  Process {
    id: getSessionProc
    running: false
    command: []
    stdout: StdioCollector {
      id: getSessionStdout
      waitForEnd: true
      onStreamFinished: root.parseSessionDetail(getSessionStdout.text)
    }
    stderr: StdioCollector {
      id: getSessionStderr
      waitForEnd: true
      onStreamFinished: {
        if (getSessionStderr.text && getSessionStderr.text.trim()) console.warn("hermes-bridge/get-session stderr:", getSessionStderr.text)
      }
    }
  }

  Process {
    id: deleteSessionProc
    running: false
    command: []
    stdout: StdioCollector {
      id: deleteStdout
      waitForEnd: true
      onStreamFinished: root.refreshSessions()
    }
  }

  Process {
    id: renameSessionProc
    running: false
    command: []
    stdout: StdioCollector {
      id: renameStdout
      waitForEnd: true
      onStreamFinished: root.refreshSessions()
    }
  }

  Process {
    id: getSettingsProc
    running: false
    command: []
    stdout: StdioCollector {
      id: getSettingsStdout
      waitForEnd: true
      onStreamFinished: root.parseSettings(getSettingsStdout.text)
    }
    stderr: StdioCollector {
      id: getSettingsStderr
      waitForEnd: true
      onStreamFinished: {
        if (getSettingsStderr.text && getSettingsStderr.text.trim()) console.warn("hermes-bridge/get-settings stderr:", getSettingsStderr.text)
      }
    }
  }

  Process {
    id: saveSettingsProc
    running: false
    command: []
    stdout: StdioCollector {
      id: saveSettingsStdout
      waitForEnd: true
      onStreamFinished: root.parseSaveSettingsResult(saveSettingsStdout.text)
    }
    stderr: StdioCollector {
      id: saveSettingsStderr
      waitForEnd: true
      onStreamFinished: {
        if (saveSettingsStderr.text && saveSettingsStderr.text.trim()) console.warn("hermes-bridge/save-settings stderr:", saveSettingsStderr.text)
      }
    }
  }

  Component {
    id: streamProcessComponent
    Process {
      id: proc
      property string targetSessionId: ""
      running: false
      command: []
      stdout: SplitParser {
        onRead: function(line) {
          root.handleStreamEvent(proc.targetSessionId, line)
        }
      }
      stderr: StdioCollector {
        id: procStderr
        waitForEnd: true
        onStreamFinished: function(text) {
          if (text && text.trim()) console.warn("hermes-bridge/stream-chat stderr [" + proc.targetSessionId + "]:", text)
        }
      }
      onExited: function(exitCode) {
        if (root.isSessionStreaming(proc.targetSessionId)) {
          var streamInfo = root.activeStreams[proc.targetSessionId]
          var hasContent = streamInfo && streamInfo.streamingContent
          if (exitCode !== 0 && !hasContent) {
            var errText = String(procStderr.text || "").trim() || "Bridge process error (code " + exitCode + ")"
            root.finishSessionStream(proc.targetSessionId, errText, true, streamInfo ? streamInfo.toolEvents : [])
          } else if (exitCode !== 0 && hasContent) {
            root.finishSessionStream(proc.targetSessionId, streamInfo.streamingContent, false, streamInfo.toolEvents)
          }
        }
      }
    }
  }

  Component.onCompleted: {
    triggerRefresh()
  }

  Timer {
    interval: Math.max(5000, Number(root.settings?.refreshIntervalSec || 30) * 1000)
    running: true
    repeat: true
    onTriggered: {
      root.checkStatus()
      if (root.opened) {
        root.refreshSessions()
      }
    }
  }

  // ------------------------------------------------------------- Bar Button

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    tooltipText: root.isConnected ? (root.serverName + " (Live)") : (root.serverName + " (Offline)")

    iconComponent: Component {
      Item {
        anchors.fill: parent

        Text {
          id: iconGlyph
          anchors.centerIn: parent
          text: root.setting("icon", "\u{f06d3}") // Feather (f06d3)
          textFormat: Text.PlainText
          font.family: root.fontFamily
          font.pixelSize: Style.bar.iconFont
          renderType: Text.NativeRendering
          color: root.opened ? root.accent : (root.isStreaming ? "#10B981" : (root.isConnected ? root.foreground : root.dimText))
        }

        // Active indicator dot in the lower right corner of the feather
        Rectangle {
          width: 4
          height: 4
          radius: 2
          anchors.right: iconGlyph.right
          anchors.bottom: iconGlyph.bottom
          anchors.rightMargin: -1
          anchors.bottomMargin: 2
          color: root.isStreaming ? "#10B981" : (root.isConnected ? "#3B82F6" : "#EF4444")

          SequentialAnimation on opacity {
            running: root.isStreaming
            loops: Animation.Infinite
            NumberAnimation { from: 0.3; to: 1.0; duration: 500 }
            NumberAnimation { from: 1.0; to: 0.3; duration: 500 }
          }
        }
      }
    }

    onPressed: function(b) {
      if (b === Qt.RightButton || b === Qt.MiddleButton) {
        root.triggerRefresh()
      } else {
        root.toggle()
      }
    }
  }

  // ------------------------------------------------------------- Popup Dialog Panel

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(720))
    contentHeight: panel.fittedContentHeight(Style.space(560), Style.space(640))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: Boolean(promptInput && promptInput.activeFocus)
      onMoveRequested: function(dx, dy) {
        if (dy < 0) {
          root.navigatePromptHistory(true)
          if (promptInput) promptInput.forceActiveFocus()
        } else if (dy > 0) {
          root.navigatePromptHistory(false)
          if (promptInput) promptInput.forceActiveFocus()
        }
      }
      onCloseRequested: {
        if (root.isSettingsOpen) {
          root.isSettingsOpen = false
          root.loadSettings()
        } else if (root.isConfirmingDeleteSession) {
          root.isConfirmingDeleteSession = false
        } else if (root.isEditingTitle) {
          root.isEditingTitle = false
        } else {
          root.close()
        }
      }

      ColumnLayout {
        anchors.fill: parent
        spacing: 0

        // ------------------------- Top Header
        Rectangle {
          Layout.fillWidth: true
          height: 48
          color: root.cardBg
          radius: 8

          RowLayout {
            anchors.fill: parent
            anchors.margins: 10
            spacing: 8

            Text {
              text: root.setting("icon", "\u{f06d3}")
              font.family: root.fontFamily
              font.pixelSize: 14
              color: root.accent
            }

            Text {
              text: root.isSettingsOpen ? (root.serverName + " • Settings") : root.serverName
              font.family: root.fontFamily
              font.pixelSize: 14
              font.weight: Font.Bold
              color: root.foreground
            }

            // Health indicator dot
            Rectangle {
              width: 8
              height: 8
              radius: 4
              color: root.isConnected ? "#10B981" : "#EF4444"
              Layout.alignment: Qt.AlignVCenter
            }

            Item { Layout.fillWidth: true }

            // New Session Button
            Rectangle {
              height: 28
              radius: 6
              color: newHover.containsMouse ? root.cardHover : root.cardBg
              border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.15)
              implicitWidth: newRow.implicitWidth + 16

              MouseArea {
                id: newHover
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                  if (root.isSettingsOpen) root.isSettingsOpen = false
                  root.startNewSession()
                }
              }

              RowLayout {
                id: newRow
                anchors.centerIn: parent
                spacing: 6

                Text {
                  text: "\uF067" // Plus icon
                  font.family: root.fontFamily
                  font.pixelSize: 11
                  color: root.accent
                }

                Text {
                  text: "New Session"
                  font.family: root.fontFamily
                  font.pixelSize: 11
                  font.weight: Font.Medium
                  color: root.foreground
                }
              }
            }

            // Refresh button
            Rectangle {
              width: 28
              height: 28
              radius: 6
              color: refreshHover.containsMouse ? root.cardHover : "transparent"

              MouseArea {
                id: refreshHover
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.triggerRefresh()
              }

              Text {
                id: refreshIcon
                anchors.centerIn: parent
                text: "\uF021" // Refresh icon
                font.family: root.fontFamily
                font.pixelSize: 12
                color: root.isRefreshing ? root.accent : root.foreground
                transformOrigin: Item.Center
                rotation: 0

                NumberAnimation on rotation {
                  running: root.isRefreshing
                  from: 0
                  to: 360
                  duration: 600
                  loops: Animation.Infinite
                }
              }
            }

            // Settings button
            Rectangle {
              width: 28
              height: 28
              radius: 6
              color: root.isSettingsOpen
                ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.2)
                : (settingsHover.containsMouse ? root.cardHover : "transparent")
              border.color: root.isSettingsOpen ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.4) : "transparent"

              MouseArea {
                id: settingsHover
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                  root.isSettingsOpen = !root.isSettingsOpen
                  if (root.isSettingsOpen) {
                    root.loadSettings()
                  }
                }
              }

              Text {
                anchors.centerIn: parent
                text: "\uF013" // Gear icon
                font.family: root.fontFamily
                font.pixelSize: 12
                color: root.isSettingsOpen ? root.accent : (settingsHover.containsMouse ? root.foreground : root.dimText)
              }
            }
          }
        }

        PanelSeparator {
          Layout.fillWidth: true
          foreground: root.foreground
        }

        // ------------------------- Dual-Pane Body
        RowLayout {
          visible: !root.isSettingsOpen
          Layout.fillWidth: true
          Layout.fillHeight: true
          spacing: 0

          // ==================== Left Drawer: Session List
          Rectangle {
            Layout.fillHeight: true
            Layout.preferredWidth: 230
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.02)

            ColumnLayout {
              anchors.fill: parent
              anchors.margins: 8
              spacing: 6

              // Search / Filter box
              Rectangle {
                Layout.fillWidth: true
                height: 30
                color: root.cardBg
                radius: 6
                border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.1)

                RowLayout {
                  anchors.fill: parent
                  anchors.margins: 6
                  spacing: 6

                  Text {
                    text: "\uF002" // Search icon
                    font.family: root.fontFamily
                    font.pixelSize: 10
                    color: root.dimText
                  }

                  TextInput {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    verticalAlignment: TextInput.AlignVCenter
                    font.family: root.fontFamily
                    font.pixelSize: 11
                    color: root.foreground
                    clip: true
                    onTextChanged: root.searchQuery = text

                    Text {
                      anchors.verticalCenter: parent.verticalCenter
                      anchors.left: parent.left
                      text: "Search sessions..."
                      font.family: root.fontFamily
                      font.pixelSize: 11
                      color: root.dimText
                      visible: !parent.text
                    }
                  }
                }
              }

              // Session list scroll
              ListView {
                id: sessionListView
                Layout.fillWidth: true
                Layout.fillHeight: true
                clip: true
                model: root.filteredSessions
                spacing: 4
                boundsBehavior: Flickable.StopAtBounds

                displaced: Transition {
                  NumberAnimation {
                    properties: "y"
                    duration: 250
                    easing.type: Easing.OutCubic
                  }
                }

                delegate: Rectangle {
                  id: sessionDelegate
                  width: sessionListView.width
                  height: 50
                  radius: 6
                  color: root.selectedSessionId === modelData.id
                    ? root.cardHover
                    : (delegateMouse.containsMouse ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.05) : "transparent")
                  border.color: root.selectedSessionId === modelData.id ? root.accent : "transparent"

                  MouseArea {
                    id: delegateMouse
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.selectSession(modelData.id)
                  }

                  RowLayout {
                    anchors.fill: parent
                    anchors.margins: 8
                    spacing: 6

                    ColumnLayout {
                      Layout.fillWidth: true
                      spacing: 2

                      Text {
                        text: modelData.title || "Untitled Session"
                        font.family: root.fontFamily
                        font.pixelSize: 11
                        font.weight: Font.Medium
                        color: root.foreground
                        elide: Text.ElideRight
                        Layout.fillWidth: true
                      }

                      RowLayout {
                        spacing: 4
                        Text {
                          text: modelData.source || "hermes"
                          font.family: root.fontFamily
                          font.pixelSize: 9
                          color: root.accent
                        }
                        Text {
                          text: "• " + (modelData.message_count || 0) + " msgs"
                          font.family: root.fontFamily
                          font.pixelSize: 9
                          color: root.dimText
                        }
                      }
                    }

                    // Trailing status slot for in-progress streaming dot
                    Item {
                      width: 20
                      Layout.fillHeight: true

                      Rectangle {
                        id: sessionProgressDot
                        width: 6
                        height: 6
                        radius: 3
                        anchors.centerIn: parent
                        color: "#10B981"
                        visible: !!(root.activeStreams && root.activeStreams[modelData.id])

                        SequentialAnimation on opacity {
                          running: sessionProgressDot.visible
                          loops: Animation.Infinite
                          NumberAnimation { from: 0.3; to: 1.0; duration: 500 }
                          NumberAnimation { from: 1.0; to: 0.3; duration: 500 }
                        }
                      }
                    }
                  }
                }

                Text {
                  anchors.centerIn: parent
                  text: root.filteredSessions.length === 0 ? "No sessions found" : ""
                  font.family: root.fontFamily
                  font.pixelSize: 11
                  color: root.dimText
                  visible: root.filteredSessions.length === 0
                }
              }
            }
          }

          Rectangle {
            Layout.fillHeight: true
            width: 1
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)
          }

          // ==================== Right Area: Active Chat
          ColumnLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 0

            // Sub-header displaying active session title & model
            Rectangle {
              Layout.fillWidth: true
              height: 34
              color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.02)

              RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 12
                anchors.rightMargin: 12
                spacing: 6

                // When viewing title
                Item {
                  visible: !root.isEditingTitle && !root.isConfirmingDeleteSession
                  Layout.fillWidth: true
                  Layout.fillHeight: true

                  RowLayout {
                    anchors.fill: parent
                    spacing: 6

                    Text {
                      text: root.selectedSessionId ? root.activeSessionTitle : "New Session"
                      font.family: root.fontFamily
                      font.pixelSize: 11
                      font.weight: Font.Medium
                      color: root.foreground
                      elide: Text.ElideRight
                      Layout.fillWidth: true
                    }

                    // Edit title icon button
                    Rectangle {
                      visible: !!root.selectedSessionId
                      width: 22
                      height: 22
                      radius: 4
                      color: editHover.containsMouse ? root.cardHover : "transparent"

                      MouseArea {
                        id: editHover
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: {
                          root.isConfirmingDeleteSession = false
                          root.isEditingTitle = true
                          editTitleInput.text = root.activeSessionTitle
                          Qt.callLater(function() {
                            editTitleInput.selectAll()
                            editTitleInput.forceActiveFocus()
                          })
                        }
                      }

                      Text {
                        anchors.centerIn: parent
                        text: "\uF044" // Edit / Pen icon
                        font.family: root.fontFamily
                        font.pixelSize: 10
                        color: editHover.containsMouse ? root.accent : root.dimText
                      }
                    }

                    // Delete session icon button
                    Rectangle {
                      visible: !!root.selectedSessionId
                      width: 22
                      height: 22
                      radius: 4
                      color: headerDelHover.containsMouse ? Qt.rgba(239/255, 68/255, 68/255, 0.2) : "transparent"

                      MouseArea {
                        id: headerDelHover
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: {
                          root.isEditingTitle = false
                          root.isConfirmingDeleteSession = true
                        }
                      }

                      Text {
                        anchors.centerIn: parent
                        text: "\uF1F8" // Trash icon
                        font.family: root.fontFamily
                        font.pixelSize: 10
                        color: headerDelHover.containsMouse ? "#EF4444" : root.dimText
                      }
                    }
                  }
                }

                // When confirming session deletion
                Item {
                  visible: root.isConfirmingDeleteSession && !root.isEditingTitle
                  Layout.fillWidth: true
                  Layout.fillHeight: true

                  RowLayout {
                    anchors.fill: parent
                    spacing: 6

                    Text {
                      text: "Delete this session?"
                      font.family: root.fontFamily
                      font.pixelSize: 11
                      font.weight: Font.DemiBold
                      color: "#EF4444"
                      elide: Text.ElideRight
                      Layout.fillWidth: true
                    }

                    // Confirm Delete Checkmark button
                    Rectangle {
                      width: 22
                      height: 22
                      radius: 4
                      color: confirmDelHeaderHover.containsMouse ? "#EF4444" : Qt.rgba(239/255, 68/255, 68/255, 0.2)

                      MouseArea {
                        id: confirmDelHeaderHover
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: {
                          var targetId = root.selectedSessionId
                          root.isConfirmingDeleteSession = false
                          if (targetId) {
                            root.deleteSession(targetId)
                          }
                        }
                      }

                      Text {
                        anchors.centerIn: parent
                        text: "\uF00C" // Checkmark
                        font.family: root.fontFamily
                        font.pixelSize: 10
                        color: confirmDelHeaderHover.containsMouse ? "#FFFFFF" : "#EF4444"
                      }
                    }

                    // Cancel Delete Cross button
                    Rectangle {
                      width: 22
                      height: 22
                      radius: 4
                      color: cancelDelHeaderHover.containsMouse ? root.cardHover : "transparent"

                      MouseArea {
                        id: cancelDelHeaderHover
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.isConfirmingDeleteSession = false
                      }

                      Text {
                        anchors.centerIn: parent
                        text: "\uF00D" // Times / Cross
                        font.family: root.fontFamily
                        font.pixelSize: 10
                        color: root.dimText
                      }
                    }
                  }
                }

                // When inline editing title
                Item {
                  visible: root.isEditingTitle
                  Layout.fillWidth: true
                  Layout.fillHeight: true

                  RowLayout {
                    anchors.fill: parent
                    spacing: 6

                    Rectangle {
                      Layout.fillWidth: true
                      height: 24
                      radius: 4
                      color: root.cardBg
                      border.color: root.accent

                      TextInput {
                        id: editTitleInput
                        anchors.fill: parent
                        anchors.leftMargin: 6
                        anchors.rightMargin: 6
                        verticalAlignment: TextInput.AlignVCenter
                        font.family: root.fontFamily
                        font.pixelSize: 11
                        color: root.foreground
                        clip: true
                        onAccepted: root.saveSessionTitle(editTitleInput.text)
                        Keys.onEscapePressed: root.isEditingTitle = false
                      }
                    }

                    // Save Checkmark button
                    Rectangle {
                      width: 22
                      height: 22
                      radius: 4
                      color: saveHover.containsMouse ? Qt.rgba(16/255, 185/255, 129/255, 0.2) : "transparent"

                      MouseArea {
                        id: saveHover
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.saveSessionTitle(editTitleInput.text)
                      }

                      Text {
                        anchors.centerIn: parent
                        text: "\uF00C" // Checkmark
                        font.family: root.fontFamily
                        font.pixelSize: 10
                        color: "#10B981"
                      }
                    }

                    // Cancel Cross button
                    Rectangle {
                      width: 22
                      height: 22
                      radius: 4
                      color: cancelHover.containsMouse ? Qt.rgba(239/255, 68/255, 68/255, 0.2) : "transparent"

                      MouseArea {
                        id: cancelHover
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.isEditingTitle = false
                      }

                      Text {
                        anchors.centerIn: parent
                        text: "\uF00D" // Times / Cross
                        font.family: root.fontFamily
                        font.pixelSize: 10
                        color: "#EF4444"
                      }
                    }
                  }
                }

                Text {
                  text: root.currentModel
                  font.family: root.fontFamily
                  font.pixelSize: 9
                  color: root.dimText
                }
              }
            }

            Rectangle {
              Layout.fillWidth: true
              height: 1
              color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
            }

            // Chat Viewport
            Flickable {
              id: chatFlick
              Layout.fillWidth: true
              Layout.fillHeight: true
              contentWidth: width
              contentHeight: chatColumn.implicitHeight + 20
              clip: true
              boundsBehavior: Flickable.StopAtBounds
              flickableDirection: Flickable.VerticalFlick
              ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

              onContentYChanged: {
                var maxScroll = Math.max(0, contentHeight - height)
                root.isNearBottom = (maxScroll - contentY) <= 80
              }

              ColumnLayout {
                id: chatColumn
                width: chatFlick.width
                spacing: 12

                onImplicitHeightChanged: {
                  if (root.isNearBottom) {
                    chatFlick.contentY = Math.max(0, chatFlick.contentHeight - chatFlick.height)
                  }
                }

                // Empty state greeting
                Item {
                  Layout.fillWidth: true
                  implicitHeight: emptyCol.implicitHeight + 40
                  visible: root.messages.length === 0 && !root.isCurrentSessionStreaming

                  ColumnLayout {
                    id: emptyCol
                    anchors.centerIn: parent
                    width: Math.min(parent.width - 40, 440)
                    spacing: 12

                    Text {
                      text: root.setting("icon", "\u{f06d3}")
                      font.family: root.fontFamily
                      font.pixelSize: 32
                      color: root.accent
                      Layout.alignment: Qt.AlignHCenter
                    }

                    Text {
                      text: "How can " + root.serverName + " help you today?"
                      font.family: root.fontFamily
                      font.pixelSize: 14
                      font.weight: Font.DemiBold
                      color: root.foreground
                      Layout.alignment: Qt.AlignHCenter
                    }

                    Text {
                      text: "Type a prompt below to assign a task or start a conversation."
                      font.family: root.fontFamily
                      font.pixelSize: 11
                      color: root.dimText
                      Layout.alignment: Qt.AlignHCenter
                    }

                    // Custom System Prompt Toggle Pill
                    Rectangle {
                      Layout.alignment: Qt.AlignHCenter
                      height: 26
                      radius: 13
                      color: sysPromptHover.containsMouse ? root.cardHover : (root.showSystemPromptInput || root.sessionSystemPrompt ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.15) : root.cardBg)
                      border.color: root.showSystemPromptInput || root.sessionSystemPrompt ? root.accent : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
                      implicitWidth: sysPromptRow.implicitWidth + 18

                      MouseArea {
                        id: sysPromptHover
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: {
                          root.showSystemPromptInput = !root.showSystemPromptInput
                          if (root.showSystemPromptInput) {
                            Qt.callLater(function() {
                              if (sysPromptInput) sysPromptInput.forceActiveFocus()
                            })
                          }
                        }
                      }

                      RowLayout {
                        id: sysPromptRow
                        anchors.centerIn: parent
                        spacing: 6

                        Text {
                          text: "\uF013" // Gear icon
                          font.family: root.fontFamily
                          font.pixelSize: 10
                          color: root.showSystemPromptInput || root.sessionSystemPrompt ? root.accent : root.dimText
                        }

                        Text {
                          text: root.sessionSystemPrompt ? "Custom System Prompt Active" : "Set System Prompt (Optional)"
                          font.family: root.fontFamily
                          font.pixelSize: 10
                          font.weight: Font.Medium
                          color: root.showSystemPromptInput || root.sessionSystemPrompt ? root.accent : root.foreground
                        }

                        Text {
                          text: root.showSystemPromptInput ? "\uF077" : "\uF078" // Chevron up/down
                          font.family: root.fontFamily
                          font.pixelSize: 8
                          color: root.dimText
                        }
                      }
                    }

                    // Expandable System Prompt Input Card
                    Rectangle {
                      visible: root.showSystemPromptInput
                      Layout.fillWidth: true
                      height: 64
                      radius: 6
                      color: root.cardBg
                      border.color: root.accent
                      clip: true

                      TextInput {
                        id: sysPromptInput
                        anchors.fill: parent
                        anchors.margins: 8
                        font.family: root.fontFamily
                        font.pixelSize: 11
                        color: root.foreground
                        clip: true
                        text: root.sessionSystemPrompt
                        onTextChanged: root.sessionSystemPrompt = text

                        Text {
                          anchors.top: parent.top
                          anchors.left: parent.left
                          text: "e.g. You are a concise Linux assistant who writes clean bash scripts..."
                          font.family: root.fontFamily
                          font.pixelSize: 11
                          color: root.dimText
                          visible: !parent.text && !parent.activeFocus
                        }
                      }
                    }

                    // Quick suggestion pills
                    RowLayout {
                      Layout.alignment: Qt.AlignHCenter
                      spacing: 8

                      Rectangle {
                        height: 26
                        radius: 13
                        color: pill1Hover.containsMouse ? root.cardHover : root.cardBg
                        border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
                        implicitWidth: pill1Text.implicitWidth + 16

                        MouseArea {
                          id: pill1Hover
                          anchors.fill: parent
                          hoverEnabled: true
                          cursorShape: Qt.PointingHandCursor
                          onClicked: {
                            if (promptInput) {
                              promptInput.text = "Check the local weather forecast."
                              root.sendCurrentMessage()
                            }
                          }
                        }

                        Text {
                          id: pill1Text
                          anchors.centerIn: parent
                          text: "🌤 Check Weather"
                          font.family: root.fontFamily
                          font.pixelSize: 10
                          color: root.foreground
                        }
                      }

                      Rectangle {
                        height: 26
                        radius: 13
                        color: pill2Hover.containsMouse ? root.cardHover : root.cardBg
                        border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
                        implicitWidth: pill2Text.implicitWidth + 16

                        MouseArea {
                          id: pill2Hover
                          anchors.fill: parent
                          hoverEnabled: true
                          cursorShape: Qt.PointingHandCursor
                          onClicked: {
                            if (promptInput) {
                              promptInput.text = "Give me a quick summary of the system."
                              root.sendCurrentMessage()
                            }
                          }
                        }

                        Text {
                          id: pill2Text
                          anchors.centerIn: parent
                          text: "⚡ System Summary"
                          font.family: root.fontFamily
                          font.pixelSize: 10
                          color: root.foreground
                        }
                      }
                    }
                  }
                }

                // Render Messages
                Repeater {
                  model: root.messages

                  delegate: Item {
                    Layout.fillWidth: true
                    implicitHeight: bubbleCol.implicitHeight + 8

                    ColumnLayout {
                      id: bubbleCol
                      width: parent.width - 24
                      anchors.horizontalCenter: parent.horizontalCenter
                      spacing: 4

                      // Live tool events attached to assistant message
                      Repeater {
                        model: modelData.tool_events || []
                        delegate: Rectangle {
                          id: liveEventBox
                          property bool expanded: false
                          Layout.fillWidth: true
                          radius: 5
                          color: root.toolBadgeBg
                          border.color: root.toolBadgeBorder
                          clip: true
                          implicitHeight: expanded ? (liveEventCol.implicitHeight + 14) : 28

                          Behavior on implicitHeight {
                            NumberAnimation { duration: 150; easing.type: Easing.OutQuad }
                          }

                          MouseArea {
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            hoverEnabled: true
                            onClicked: liveEventBox.expanded = !liveEventBox.expanded
                          }

                          ColumnLayout {
                            id: liveEventCol
                            anchors.fill: parent
                            anchors.margins: 6
                            spacing: 4

                            RowLayout {
                              Layout.fillWidth: true
                              spacing: 6

                              Text {
                                text: modelData.emoji || "\uF0AD"
                                font.family: modelData.emoji ? "sans-serif" : root.fontFamily
                                font.pixelSize: 11
                                color: root.toolBadgeText
                              }

                              Text {
                                text: (modelData.tool || "tool") + (modelData.label ? (": " + modelData.label) : "")
                                font.family: root.fontFamily
                                font.pixelSize: 10
                                font.weight: Font.Medium
                                color: root.toolBadgeText
                                elide: Text.ElideRight
                                Layout.fillWidth: true
                              }

                              Text {
                                text: liveEventBox.expanded ? "\uF077" : "\uF078"
                                font.family: root.fontFamily
                                font.pixelSize: 9
                                color: root.toolBadgeText
                                visible: !!modelData.output || !!modelData.detail
                              }
                            }

                            Text {
                              visible: liveEventBox.expanded && (!!modelData.output || !!modelData.detail)
                              text: modelData.output || modelData.detail || ""
                              font.family: "monospace"
                              font.pixelSize: 9
                              color: root.foreground
                              wrapMode: Text.Wrap
                              Layout.fillWidth: true
                            }
                          }
                        }
                      }

                      // Persisted tool calls attached to assistant message
                      Repeater {
                        model: modelData.tool_calls || []
                        delegate: Rectangle {
                          id: toolCallBox
                          property bool expanded: false
                          Layout.fillWidth: true
                          radius: 5
                          color: root.toolBadgeBg
                          border.color: root.toolBadgeBorder
                          clip: true
                          implicitHeight: expanded ? (toolCallCol.implicitHeight + 14) : 28

                          Behavior on implicitHeight {
                            NumberAnimation { duration: 150; easing.type: Easing.OutQuad }
                          }

                          MouseArea {
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            hoverEnabled: true
                            onClicked: toolCallBox.expanded = !toolCallBox.expanded
                          }

                          ColumnLayout {
                            id: toolCallCol
                            anchors.fill: parent
                            anchors.margins: 6
                            spacing: 4

                            RowLayout {
                              Layout.fillWidth: true
                              spacing: 6

                              Text {
                                text: "\uF0AD" // Wrench
                                font.family: root.fontFamily
                                font.pixelSize: 10
                                color: root.toolBadgeText
                              }

                              Text {
                                text: (modelData.name || "tool") + (modelData.summary ? (": " + modelData.summary) : "")
                                font.family: root.fontFamily
                                font.pixelSize: 10
                                font.weight: Font.Medium
                                color: root.toolBadgeText
                                elide: Text.ElideRight
                                Layout.fillWidth: true
                              }

                              Text {
                                text: toolCallBox.expanded ? "\uF077" : "\uF078"
                                font.family: root.fontFamily
                                font.pixelSize: 9
                                color: root.toolBadgeText
                              }
                            }

                            Text {
                              visible: toolCallBox.expanded
                              text: modelData.arguments || modelData.summary || ""
                              font.family: "monospace"
                              font.pixelSize: 9
                              color: root.foreground
                              wrapMode: Text.Wrap
                              Layout.fillWidth: true
                            }
                          }
                        }
                      }

                      // Tool Output Result Card (Single-line, expandable)
                      Rectangle {
                        id: toolResultBox
                        visible: modelData.role === "tool"
                        property bool expanded: false
                        Layout.fillWidth: true
                        radius: 5
                        color: root.toolBadgeBg
                        border.color: root.toolBadgeBorder
                        clip: true
                        implicitHeight: expanded ? (toolResultCol.implicitHeight + 14) : 28

                        Behavior on implicitHeight {
                          NumberAnimation { duration: 150; easing.type: Easing.OutQuad }
                        }

                        MouseArea {
                          anchors.fill: parent
                          cursorShape: Qt.PointingHandCursor
                          hoverEnabled: true
                          onClicked: toolResultBox.expanded = !toolResultBox.expanded
                        }

                        ColumnLayout {
                          id: toolResultCol
                          anchors.fill: parent
                          anchors.margins: 6
                          spacing: 4

                          RowLayout {
                            Layout.fillWidth: true
                            spacing: 6

                            Text {
                              text: "\uF0AD"
                              font.family: root.fontFamily
                              font.pixelSize: 10
                              color: root.toolBadgeText
                            }

                            Text {
                              text: "Tool Output" + (modelData.tool_name ? (" (" + modelData.tool_name + ")") : "") + ": " + (modelData.tool_preview || String(modelData.content || "").replace(/\s+/g, " ").trim())
                              font.family: root.fontFamily
                              font.pixelSize: 10
                              font.weight: Font.Medium
                              color: root.toolBadgeText
                              elide: Text.ElideRight
                              Layout.fillWidth: true
                            }

                            Text {
                              text: toolResultBox.expanded ? "\uF077" : "\uF078"
                              font.family: root.fontFamily
                              font.pixelSize: 9
                              color: root.toolBadgeText
                            }
                          }

                          Text {
                            visible: toolResultBox.expanded
                            text: modelData.tool_formatted || String(modelData.content || "").trim()
                            font.family: "monospace"
                            font.pixelSize: 9
                            color: root.foreground
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                          }
                        }
                      }

                      // User / Assistant Bubble Card
                      Rectangle {
                        visible: modelData.role !== "tool" && (modelData.content && String(modelData.content).trim() !== "")
                        Layout.alignment: modelData.role === "user" ? Qt.AlignRight : Qt.AlignLeft
                        Layout.maximumWidth: parent.width * 0.88
                        implicitWidth: msgText.implicitWidth + 20
                        implicitHeight: msgText.implicitHeight + 16
                        radius: 8
                        color: modelData.role === "user" ? root.userBubbleBg : root.cardBg
                        border.color: modelData.role === "user" ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.3) : "transparent"

                        Text {
                          id: msgText
                          anchors.fill: parent
                          anchors.margins: 8
                          text: String(modelData.content || "").trim()
                          font.family: root.fontFamily
                          font.pixelSize: 11
                          color: root.foreground
                          wrapMode: Text.Wrap
                          textFormat: modelData.role === "assistant" ? Text.MarkdownText : Text.PlainText
                          onLinkActivated: function(link) { Qt.openUrlExternally(link) }
                        }
                      }

                      // Subtle timestamp
                      Text {
                        Layout.alignment: modelData.role === "user" ? Qt.AlignRight : Qt.AlignLeft
                        text: root.formatTime(modelData.timestamp)
                        font.family: root.fontFamily
                        font.pixelSize: 9
                        color: root.subtleText
                        visible: !!modelData.timestamp
                      }
                    }
                  }
                }

                // Real-time streaming assistant bubble
                Item {
                  Layout.fillWidth: true
                  implicitHeight: streamCol.implicitHeight + 8
                  visible: root.isCurrentSessionStreaming

                  ColumnLayout {
                    id: streamCol
                    width: parent.width - 24
                    anchors.horizontalCenter: parent.horizontalCenter
                    spacing: 4

                    // Live tool progress badges
                    Repeater {
                      model: root.currentToolEvents
                      delegate: Rectangle {
                        Layout.fillWidth: true
                        height: 26
                        radius: 4
                        color: root.toolBadgeBg
                        border.color: root.toolBadgeBorder

                        RowLayout {
                          anchors.fill: parent
                          anchors.margins: 5
                          spacing: 6

                          Text {
                            text: modelData.emoji || "\uF0AD"
                            font.family: modelData.emoji ? "sans-serif" : root.fontFamily
                            font.pixelSize: 11
                            color: root.toolBadgeText
                          }

                          Text {
                            text: (modelData.tool || "tool") + (modelData.label ? (": " + modelData.label) : "") + " (" + (modelData.status || "running") + ")"
                            font.family: root.fontFamily
                            font.pixelSize: 10
                            font.weight: Font.Medium
                            color: root.toolBadgeText
                            elide: Text.ElideRight
                            Layout.fillWidth: true
                          }
                        }
                      }
                    }

                    // Live streaming / thinking message card
                    Rectangle {
                      Layout.alignment: Qt.AlignLeft
                      Layout.maximumWidth: parent.width * 0.88
                      implicitWidth: root.currentStreamingContent ? (streamText.implicitWidth + 24) : (thinkingRow.implicitWidth + 24)
                      implicitHeight: root.currentStreamingContent ? (streamText.implicitHeight + 16) : (thinkingRow.implicitHeight + 16)
                      radius: 8
                      color: root.cardBg

                      RowLayout {
                        id: thinkingRow
                        anchors.fill: parent
                        anchors.margins: 8
                        spacing: 8
                        visible: !root.currentStreamingContent

                        Text {
                          text: "●"
                          font.family: root.fontFamily
                          font.pixelSize: 10
                          color: root.accent

                          SequentialAnimation on opacity {
                            running: root.isCurrentSessionStreaming && !root.currentStreamingContent
                            loops: Animation.Infinite
                            NumberAnimation { from: 0.2; to: 1.0; duration: 400 }
                            NumberAnimation { from: 1.0; to: 0.2; duration: 400 }
                          }
                        }

                        Text {
                          text: root.serverName + " is thinking..."
                          font.family: root.fontFamily
                          font.pixelSize: 11
                          color: root.dimText
                        }
                      }

                      Text {
                        id: streamText
                        anchors.fill: parent
                        anchors.margins: 8
                        visible: !!root.currentStreamingContent
                        text: String(root.currentStreamingContent || "").trim()
                        font.family: root.fontFamily
                        font.pixelSize: 11
                        color: root.foreground
                        wrapMode: Text.Wrap
                        textFormat: Text.MarkdownText
                        onLinkActivated: function(link) { Qt.openUrlExternally(link) }
                      }
                    }
                  }
                }
              }
            }

            PanelSeparator {
              Layout.fillWidth: true
              foreground: root.foreground
            }

            // ------------------------- Bottom Prompt Input Area
            Rectangle {
              Layout.fillWidth: true
              height: 52
              color: root.cardBg

              RowLayout {
                anchors.fill: parent
                anchors.margins: 8
                spacing: 8

                Rectangle {
                  Layout.fillWidth: true
                  Layout.fillHeight: true
                  radius: 6
                  color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.04)
                  border.color: promptInput.activeFocus ? root.accent : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)

                  TextInput {
                    id: promptInput
                    anchors.fill: parent
                    anchors.leftMargin: 10
                    anchors.rightMargin: 10
                    verticalAlignment: TextInput.AlignVCenter
                    font.family: root.fontFamily
                    font.pixelSize: 11
                    color: root.foreground
                    clip: true
                    focus: true
                    onAccepted: root.sendCurrentMessage()

                    Keys.onPressed: function(event) {
                      if (event.key === Qt.Key_Up) {
                        if (root.navigatePromptHistory(true)) {
                          event.accepted = true
                        }
                      } else if (event.key === Qt.Key_Down) {
                        if (root.navigatePromptHistory(false)) {
                          event.accepted = true
                        }
                      } else if (event.key === Qt.Key_Escape) {
                        if (root.isConfirmingDeleteSession) {
                          root.isConfirmingDeleteSession = false
                        } else if (root.isEditingTitle) {
                          root.isEditingTitle = false
                        } else {
                          root.close()
                        }
                        event.accepted = true
                      }
                    }

                    Text {
                      anchors.verticalCenter: parent.verticalCenter
                      anchors.left: parent.left
                      text: "Ask " + root.serverName + " a question or assign a task..."
                      font.family: root.fontFamily
                      font.pixelSize: 11
                      color: root.dimText
                      visible: !parent.text && !parent.activeFocus
                    }
                  }
                }

                // Send or Stop button
                Rectangle {
                  width: 34
                  height: 34
                  radius: 6
                  color: root.isCurrentSessionStreaming
                    ? (sendHover.containsMouse ? "#EF4444" : Qt.rgba(239/255, 68/255, 68/255, 0.2))
                    : (sendHover.containsMouse ? root.accent : Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.8))

                  MouseArea {
                    id: sendHover
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: {
                      if (root.isCurrentSessionStreaming) {
                        root.cancelStreaming(root.selectedSessionId)
                      } else {
                        root.sendCurrentMessage()
                      }
                    }
                  }

                  Text {
                    anchors.centerIn: parent
                    text: root.isCurrentSessionStreaming ? "\uF04D" : "\uF1D8" // Stop vs Send Paper Airplane
                    font.family: root.fontFamily
                    font.pixelSize: 12
                    color: root.isCurrentSessionStreaming ? (sendHover.containsMouse ? "#FFFFFF" : "#EF4444") : "#FFFFFF"
                  }
                }
              }
            }
          }
        }

        // ==================== Settings View (Master-Detail)
        RowLayout {
          visible: root.isSettingsOpen
          Layout.fillWidth: true
          Layout.fillHeight: true
          spacing: 0

          // -------------------- Left Sidebar: Endpoints List
          Rectangle {
            Layout.fillHeight: true
            Layout.preferredWidth: 220
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.02)

            ColumnLayout {
              anchors.fill: parent
              anchors.margins: 10
              spacing: 8

              // Header: Endpoints + Add Button
              RowLayout {
                Layout.fillWidth: true

                Text {
                  text: "Endpoints"
                  font.family: root.fontFamily
                  font.pixelSize: 12
                  font.weight: Font.Bold
                  color: root.foreground
                }

                Item { Layout.fillWidth: true }

                Rectangle {
                  height: 24
                  radius: 4
                  color: addEpHover.containsMouse ? root.cardHover : root.cardBg
                  border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.15)
                  implicitWidth: addEpRow.implicitWidth + 12

                  MouseArea {
                    id: addEpHover
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.addEndpoint()
                  }

                  RowLayout {
                    id: addEpRow
                    anchors.centerIn: parent
                    spacing: 4

                    Text {
                      text: "\uF067" // Plus
                      font.family: root.fontFamily
                      font.pixelSize: 10
                      color: root.accent
                    }

                    Text {
                      text: "Add"
                      font.family: root.fontFamily
                      font.pixelSize: 10
                      font.weight: Font.Medium
                      color: root.foreground
                    }
                  }
                }
              }

              // Scrollable list of endpoints
              Flickable {
                Layout.fillWidth: true
                Layout.fillHeight: true
                contentWidth: width
                contentHeight: epListCol.implicitHeight
                clip: true

                ColumnLayout {
                  id: epListCol
                  width: parent.width
                  spacing: 4

                  Repeater {
                    model: root.settingsEndpoints
                    delegate: Rectangle {
                      id: epCard
                      Layout.fillWidth: true
                      height: 48
                      radius: 6
                      color: root.selectedEndpointIndex === index
                        ? root.userBubbleBg
                        : (epCardHover.containsMouse ? root.cardHover : root.cardBg)
                      border.color: root.selectedEndpointIndex === index
                        ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.5)
                        : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)

                      MouseArea {
                        id: epCardHover
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: {
                          root.selectedEndpointIndex = index
                          root.isConfirmingDeleteEndpoint = false
                          root.settingsErrorMessage = ""
                        }
                      }

                      ColumnLayout {
                        anchors.fill: parent
                        anchors.margins: 8
                        spacing: 2

                        Text {
                          text: modelData.name || "Untitled Endpoint"
                          font.family: root.fontFamily
                          font.pixelSize: 11
                          font.weight: Font.Medium
                          color: root.foreground
                          elide: Text.ElideRight
                          Layout.fillWidth: true
                        }

                        RowLayout {
                          spacing: 4
                          Layout.fillWidth: true

                          Text {
                            text: (modelData.url || "http://127.0.0.1") + (modelData.port ? (":" + modelData.port) : "")
                            font.family: root.fontFamily
                            font.pixelSize: 9
                            color: root.dimText
                            elide: Text.ElideRight
                            Layout.fillWidth: true
                          }

                          Text {
                            text: (modelData.profiles ? modelData.profiles.length : 0) + " prof"
                            font.family: root.fontFamily
                            font.pixelSize: 9
                            color: root.accent
                          }
                        }
                      }
                    }
                  }

                  Item {
                    visible: !root.settingsEndpoints || root.settingsEndpoints.length === 0
                    Layout.fillWidth: true
                    height: 100

                    Text {
                      anchors.centerIn: parent
                      text: "No endpoints\nClick + Add"
                      font.family: root.fontFamily
                      font.pixelSize: 11
                      color: root.dimText
                      horizontalAlignment: Text.AlignHCenter
                    }
                  }
                }
              }
            }
          }

          // Pane divider
          Rectangle {
            Layout.fillHeight: true
            width: 1
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)
          }

          // -------------------- Right Editor Pane
          ColumnLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 0

            // Scrollable form content
            Flickable {
              id: settingsFormFlick
              Layout.fillWidth: true
              Layout.fillHeight: true
              contentWidth: width
              contentHeight: settingsFormCol.implicitHeight + 20
              clip: true

              ColumnLayout {
                id: settingsFormCol
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.margins: 14
                spacing: 12

                readonly property var curEp: (root.settingsEndpoints && root.selectedEndpointIndex >= 0 && root.selectedEndpointIndex < root.settingsEndpoints.length)
                  ? root.settingsEndpoints[root.selectedEndpointIndex]
                  : null

                // Empty selection placeholder
                Item {
                  visible: !settingsFormCol.curEp
                  Layout.fillWidth: true
                  height: 200

                  Text {
                    anchors.centerIn: parent
                    text: "Select an endpoint on the left or click '+ Add' to create one."
                    font.family: root.fontFamily
                    font.pixelSize: 12
                    color: root.dimText
                  }
                }

                // Active Endpoint Form
                ColumnLayout {
                  visible: !!settingsFormCol.curEp
                  Layout.fillWidth: true
                  spacing: 12

                  // Header: Section title and Delete Endpoint button
                  RowLayout {
                    Layout.fillWidth: true

                    Text {
                      text: "Endpoint Configuration"
                      font.family: root.fontFamily
                      font.pixelSize: 12
                      font.weight: Font.Bold
                      color: root.foreground
                    }

                    Item { Layout.fillWidth: true }

                    // Delete Endpoint Button (2-step confirmation)
                    Rectangle {
                      height: 26
                      radius: 4
                      color: root.isConfirmingDeleteEndpoint
                        ? (delEpHover.containsMouse ? "#DC2626" : "#EF4444")
                        : (delEpHover.containsMouse ? Qt.rgba(239/255, 68/255, 68/255, 0.2) : "transparent")
                      border.color: root.isConfirmingDeleteEndpoint ? "#EF4444" : Qt.rgba(239/255, 68/255, 68/255, 0.3)
                      implicitWidth: delEpRow.implicitWidth + 12

                      MouseArea {
                        id: delEpHover
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: {
                          if (root.isConfirmingDeleteEndpoint) {
                            root.deleteCurrentEndpoint()
                          } else {
                            root.isConfirmingDeleteEndpoint = true
                          }
                        }
                      }

                      RowLayout {
                        id: delEpRow
                        anchors.centerIn: parent
                        spacing: 4

                        Text {
                          text: "\uF1F8" // Trash
                          font.family: root.fontFamily
                          font.pixelSize: 10
                          color: root.isConfirmingDeleteEndpoint ? "#FFFFFF" : "#EF4444"
                        }

                        Text {
                          text: root.isConfirmingDeleteEndpoint ? "Confirm Delete?" : "Delete Endpoint"
                          font.family: root.fontFamily
                          font.pixelSize: 10
                          font.weight: Font.Medium
                          color: root.isConfirmingDeleteEndpoint ? "#FFFFFF" : "#EF4444"
                        }
                      }
                    }
                  }

                  // Display Name Field
                  ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 4

                    Text {
                      text: "Display Name"
                      font.family: root.fontFamily
                      font.pixelSize: 10
                      font.weight: Font.Medium
                      color: root.dimText
                    }

                    Rectangle {
                      Layout.fillWidth: true
                      height: 30
                      radius: 6
                      color: root.cardBg
                      border.color: epNameInput.activeFocus
                        ? root.accent
                        : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)

                      TextInput {
                        id: epNameInput
                        anchors.fill: parent
                        anchors.leftMargin: 8
                        anchors.rightMargin: 8
                        verticalAlignment: TextInput.AlignVCenter
                        font.family: root.fontFamily
                        font.pixelSize: 11
                        color: root.foreground
                        clip: true
                        text: settingsFormCol.curEp ? (settingsFormCol.curEp.name || "") : ""
                        onTextChanged: {
                          if (activeFocus && settingsFormCol.curEp) {
                            root.updateEndpointField(root.selectedEndpointIndex, "name", text)
                          }
                        }
                      }
                    }
                  }

                  // URL & Port Row
                  RowLayout {
                    Layout.fillWidth: true
                    spacing: 10

                    // URL
                    ColumnLayout {
                      Layout.fillWidth: true
                      spacing: 4

                      Text {
                        text: "URL (e.g. http://127.0.0.1)"
                        font.family: root.fontFamily
                        font.pixelSize: 10
                        font.weight: Font.Medium
                        color: root.dimText
                      }

                      Rectangle {
                        Layout.fillWidth: true
                        height: 30
                        radius: 6
                        color: root.cardBg
                        border.color: epUrlInput.activeFocus
                          ? root.accent
                          : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)

                        TextInput {
                          id: epUrlInput
                          anchors.fill: parent
                          anchors.leftMargin: 8
                          anchors.rightMargin: 8
                          verticalAlignment: TextInput.AlignVCenter
                          font.family: root.fontFamily
                          font.pixelSize: 11
                          color: root.foreground
                          clip: true
                          text: settingsFormCol.curEp ? (settingsFormCol.curEp.url || "") : ""
                          onTextChanged: {
                            if (activeFocus && settingsFormCol.curEp) {
                              root.updateEndpointField(root.selectedEndpointIndex, "url", text)
                            }
                          }
                        }
                      }
                    }

                    // Port
                    ColumnLayout {
                      Layout.preferredWidth: 80
                      spacing: 4

                      Text {
                        text: "Port"
                        font.family: root.fontFamily
                        font.pixelSize: 10
                        font.weight: Font.Medium
                        color: root.dimText
                      }

                      Rectangle {
                        Layout.fillWidth: true
                        height: 30
                        radius: 6
                        color: root.cardBg
                        border.color: epPortInput.activeFocus
                          ? root.accent
                          : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)

                        TextInput {
                          id: epPortInput
                          anchors.fill: parent
                          anchors.leftMargin: 8
                          anchors.rightMargin: 8
                          verticalAlignment: TextInput.AlignVCenter
                          font.family: root.fontFamily
                          font.pixelSize: 11
                          color: root.foreground
                          clip: true
                          text: settingsFormCol.curEp ? String(settingsFormCol.curEp.port || 8642) : "8642"
                          onTextChanged: {
                            if (activeFocus && settingsFormCol.curEp) {
                              root.updateEndpointField(root.selectedEndpointIndex, "port", text)
                            }
                          }
                        }
                      }
                    }
                  }

                  // Endpoint API Key Field
                  ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 4

                    Text {
                      text: "Endpoint API Key"
                      font.family: root.fontFamily
                      font.pixelSize: 10
                      font.weight: Font.Medium
                      color: root.dimText
                    }

                    Rectangle {
                      Layout.fillWidth: true
                      height: 30
                      radius: 6
                      color: root.cardBg
                      border.color: epKeyInput.activeFocus
                        ? root.accent
                        : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)

                      RowLayout {
                        anchors.fill: parent
                        anchors.leftMargin: 8
                        anchors.rightMargin: 6
                        spacing: 6

                        TextInput {
                          id: epKeyInput
                          Layout.fillWidth: true
                          Layout.fillHeight: true
                          verticalAlignment: TextInput.AlignVCenter
                          font.family: root.fontFamily
                          font.pixelSize: 11
                          color: root.foreground
                          echoMode: root.maskEndpointApiKey ? TextInput.Password : TextInput.Normal
                          clip: true
                          text: settingsFormCol.curEp ? (settingsFormCol.curEp.apiKey || "") : ""
                          onTextChanged: {
                            if (activeFocus && settingsFormCol.curEp) {
                              root.updateEndpointField(root.selectedEndpointIndex, "apiKey", text)
                            }
                          }
                        }

                        Rectangle {
                          width: 20
                          height: 20
                          radius: 4
                          color: eyeHover.containsMouse ? root.cardHover : "transparent"

                          MouseArea {
                            id: eyeHover
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.maskEndpointApiKey = !root.maskEndpointApiKey
                          }

                          Text {
                            anchors.centerIn: parent
                            text: root.maskEndpointApiKey ? "\uF070" : "\uF06E"
                            font.family: root.fontFamily
                            font.pixelSize: 11
                            color: eyeHover.containsMouse ? root.foreground : root.dimText
                          }
                        }
                      }
                    }
                  }

                  // Divider
                  Rectangle {
                    Layout.fillWidth: true
                    height: 1
                    color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)
                  }

                  // Agent Profiles Section Header
                  RowLayout {
                    Layout.fillWidth: true

                    ColumnLayout {
                      spacing: 2
                      Text {
                        text: "Agent Profiles"
                        font.family: root.fontFamily
                        font.pixelSize: 12
                        font.weight: Font.Bold
                        color: root.foreground
                      }
                      Text {
                        text: "Profiles inherit the endpoint key unless overridden"
                        font.family: root.fontFamily
                        font.pixelSize: 9
                        color: root.dimText
                      }
                    }

                    Item { Layout.fillWidth: true }

                    Rectangle {
                      height: 24
                      radius: 4
                      color: addProfHover.containsMouse ? root.cardHover : root.cardBg
                      border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.15)
                      implicitWidth: addProfRow.implicitWidth + 12

                      MouseArea {
                        id: addProfHover
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.addProfileToCurrentEndpoint()
                      }

                      RowLayout {
                        id: addProfRow
                        anchors.centerIn: parent
                        spacing: 4

                        Text {
                          text: "\uF067"
                          font.family: root.fontFamily
                          font.pixelSize: 10
                          color: root.accent
                        }

                        Text {
                          text: "Add Profile"
                          font.family: root.fontFamily
                          font.pixelSize: 10
                          font.weight: Font.Medium
                          color: root.foreground
                        }
                      }
                    }
                  }

                  // Profiles List
                  ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 6

                    Repeater {
                      model: (settingsFormCol.curEp && settingsFormCol.curEp.profiles) ? settingsFormCol.curEp.profiles : []
                      delegate: Rectangle {
                        id: profRowItem
                        Layout.fillWidth: true
                        height: 38
                        radius: 6
                        color: root.cardBg
                        border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)

                        property bool maskProfKey: true

                        RowLayout {
                          anchors.fill: parent
                          anchors.leftMargin: 8
                          anchors.rightMargin: 8
                          spacing: 8

                          // Profile Name
                          Rectangle {
                            Layout.preferredWidth: 120
                            Layout.fillHeight: true
                            color: "transparent"

                            TextInput {
                              id: profNameInput
                              anchors.fill: parent
                              verticalAlignment: TextInput.AlignVCenter
                              font.family: root.fontFamily
                              font.pixelSize: 11
                              color: root.foreground
                              clip: true
                              text: modelData.name || ""
                              onTextChanged: {
                                if (activeFocus) {
                                  root.updateProfileField(index, "name", text)
                                }
                              }
                            }

                            Text {
                              anchors.verticalCenter: parent.verticalCenter
                              text: "Profile Name"
                              font.family: root.fontFamily
                              font.pixelSize: 10
                              color: root.subtleText
                              visible: !profNameInput.text && !profNameInput.activeFocus
                            }
                          }

                          Rectangle {
                            Layout.fillHeight: true
                            width: 1
                            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)
                          }

                          // Profile API Key
                          Item {
                            Layout.fillWidth: true
                            Layout.fillHeight: true

                            TextInput {
                              id: profKeyInput
                              anchors.fill: parent
                              verticalAlignment: TextInput.AlignVCenter
                              font.family: root.fontFamily
                              font.pixelSize: 11
                              color: root.foreground
                              clip: true
                              echoMode: profRowItem.maskProfKey ? TextInput.Password : TextInput.Normal
                              text: modelData.apiKey || ""
                              onTextChanged: {
                                if (activeFocus) {
                                  root.updateProfileField(index, "apiKey", text)
                                }
                              }
                            }

                            Text {
                              anchors.verticalCenter: parent.verticalCenter
                              text: "Inherited from Endpoint"
                              font.family: root.fontFamily
                              font.pixelSize: 10
                              color: root.subtleText
                              visible: !profKeyInput.text && !profKeyInput.activeFocus
                            }
                          }

                          // Toggle eye
                          Rectangle {
                            width: 20
                            height: 20
                            radius: 4
                            color: profEyeHover.containsMouse ? root.cardHover : "transparent"

                            MouseArea {
                              id: profEyeHover
                              anchors.fill: parent
                              hoverEnabled: true
                              cursorShape: Qt.PointingHandCursor
                              onClicked: profRowItem.maskProfKey = !profRowItem.maskProfKey
                            }

                            Text {
                              anchors.centerIn: parent
                              text: profRowItem.maskProfKey ? "\uF070" : "\uF06E"
                              font.family: root.fontFamily
                              font.pixelSize: 10
                              color: profEyeHover.containsMouse ? root.foreground : root.dimText
                            }
                          }

                          // Delete profile button
                          Rectangle {
                            width: 22
                            height: 22
                            radius: 4
                            color: profDelHover.containsMouse ? Qt.rgba(239/255, 68/255, 68/255, 0.2) : "transparent"

                            MouseArea {
                              id: profDelHover
                              anchors.fill: parent
                              hoverEnabled: true
                              cursorShape: Qt.PointingHandCursor
                              onClicked: root.deleteProfileFromCurrentEndpoint(index)
                            }

                            Text {
                              anchors.centerIn: parent
                              text: "\uF1F8" // Trash
                              font.family: root.fontFamily
                              font.pixelSize: 10
                              color: profDelHover.containsMouse ? "#EF4444" : root.dimText
                            }
                          }
                        }
                      }
                    }

                    Text {
                      visible: !settingsFormCol.curEp || !settingsFormCol.curEp.profiles || settingsFormCol.curEp.profiles.length === 0
                      text: "No agent profiles configured. Click '+ Add Profile' above."
                      font.family: root.fontFamily
                      font.pixelSize: 10
                      color: root.dimText
                    }
                  }
                }
              }
            }

            // Divider above bottom action bar
            Rectangle {
              Layout.fillWidth: true
              height: 1
              color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)
            }

            // Bottom Action Bar
            Rectangle {
              Layout.fillWidth: true
              height: 48
              color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.02)

              RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 14
                anchors.rightMargin: 14
                spacing: 10

                // Error banner
                Rectangle {
                  visible: !!root.settingsErrorMessage
                  height: 28
                  radius: 4
                  color: Qt.rgba(239/255, 68/255, 68/255, 0.15)
                  border.color: Qt.rgba(239/255, 68/255, 68/255, 0.4)
                  Layout.fillWidth: true

                  RowLayout {
                    anchors.fill: parent
                    anchors.leftMargin: 8
                    anchors.rightMargin: 8
                    spacing: 6

                    Text {
                      text: "\uF00D" // Cross
                      font.family: root.fontFamily
                      font.pixelSize: 10
                      color: "#EF4444"
                    }

                    Text {
                      text: root.settingsErrorMessage
                      font.family: root.fontFamily
                      font.pixelSize: 10
                      color: "#EF4444"
                      elide: Text.ElideRight
                      Layout.fillWidth: true
                    }
                  }
                }

                // Success banner
                Rectangle {
                  visible: !root.settingsErrorMessage && !!root.settingsSuccessMessage
                  height: 28
                  radius: 4
                  color: Qt.rgba(16/255, 185/255, 129/255, 0.15)
                  border.color: Qt.rgba(16/255, 185/255, 129/255, 0.4)
                  Layout.fillWidth: true

                  RowLayout {
                    anchors.fill: parent
                    anchors.leftMargin: 8
                    anchors.rightMargin: 8
                    spacing: 6

                    Text {
                      text: "\uF00C" // Check
                      font.family: root.fontFamily
                      font.pixelSize: 10
                      color: "#10B981"
                    }

                    Text {
                      text: root.settingsSuccessMessage
                      font.family: root.fontFamily
                      font.pixelSize: 10
                      color: "#10B981"
                      elide: Text.ElideRight
                      Layout.fillWidth: true
                    }
                  }
                }

                Item {
                  visible: !root.settingsErrorMessage && !root.settingsSuccessMessage
                  Layout.fillWidth: true
                }

                // Back / Cancel Button
                Rectangle {
                  height: 28
                  radius: 6
                  color: settingsCancelHover.containsMouse ? root.cardHover : "transparent"
                  border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.15)
                  implicitWidth: cancelTxt.implicitWidth + 18

                  MouseArea {
                    id: settingsCancelHover
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: {
                      root.isSettingsOpen = false
                      root.loadSettings()
                    }
                  }

                  Text {
                    id: cancelTxt
                    anchors.centerIn: parent
                    text: "Back"
                    font.family: root.fontFamily
                    font.pixelSize: 11
                    color: root.foreground
                  }
                }

                // Save Button
                Rectangle {
                  height: 28
                  radius: 6
                  color: settingsSaveHover.containsMouse ? Qt.darker(root.accent, 1.1) : root.accent
                  implicitWidth: saveRow.implicitWidth + 18

                  MouseArea {
                    id: settingsSaveHover
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.validateAndSaveSettings()
                  }

                  RowLayout {
                    id: saveRow
                    anchors.centerIn: parent
                    spacing: 6

                    Text {
                      text: "\uF00C" // Check
                      font.family: root.fontFamily
                      font.pixelSize: 10
                      color: "#FFFFFF"
                    }

                    Text {
                      text: "Save Settings"
                      font.family: root.fontFamily
                      font.pixelSize: 11
                      font.weight: Font.Medium
                      color: "#FFFFFF"
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
