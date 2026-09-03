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
  property bool isStreaming: false
  property bool isRefreshing: false
  property bool isEditingTitle: false
  property bool showSystemPromptInput: false
  property string sessionSystemPrompt: ""
  property string serverUrl: ""
  property string statusError: ""

  // Session state
  property var sessions: []
  property var filteredSessions: []
  property string selectedSessionId: ""
  property string activeSessionTitle: "New Session"
  property string currentModel: "hermes-agent"
  property string searchQuery: ""
  property bool omarchyOnly: false
  property string streamingSessionId: ""

  // Active chat state
  property var messages: []
  property string currentStreamingContent: ""
  property var currentToolEvents: []

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
      triggerRefresh()
      Qt.callLater(function() {
        if (promptInput) promptInput.forceActiveFocus()
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
        root.sessions = res.sessions
        if (!root.selectedSessionId && res.sessions.length > 0) {
          root.selectSession(res.sessions[0].id)
        }
      }
    } catch (e) {
      console.warn("hermes-bridge/list-sessions error:", e)
    }
  }

  function selectSession(sessionId) {
    if (selectedSessionId === sessionId) return
    isEditingTitle = false
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
        root.messages = res.session.messages || []
        if (res.session.title && !res.session.title.startsWith("Session api-")) {
          root.activeSessionTitle = res.session.title
        }
        Qt.callLater(function() {
          if (chatFlick) chatFlick.contentY = Math.max(0, chatFlick.contentHeight - chatFlick.height)
        })
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

    renameSessionProc.command = ["node", root.scriptPath, "rename-session", selectedSessionId, trimmed]
    renameSessionProc.running = true
  }

  function startNewSession() {
    if (isStreaming) cancelStreaming()
    isEditingTitle = false
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
    if (selectedSessionId === sessionId) {
      startNewSession()
    }
    sessions = sessions.filter(function(s) { return s.id !== sessionId })
    deleteSessionProc.command = ["node", root.scriptPath, "delete-session", sessionId]
    deleteSessionProc.running = true
  }

  function sendCurrentMessage() {
    if (!promptInput) return
    var text = String(promptInput.text || "").trim()
    if (!text || isStreaming) return

    root.promptDraft = ""
    root.promptHistoryIndex = -1

    promptInput.text = ""
    currentStreamingContent = ""
    currentToolEvents = []
    root.streamingSessionId = root.selectedSessionId

    var updated = messages.slice()
    updated.push({ role: "user", content: text, timestamp: new Date().toISOString() })
    messages = updated

    isStreaming = true

    var args = [
      "node",
      root.scriptPath,
      "stream-chat",
      "--prompt", text,
      "--model", root.currentModel
    ]

    if (selectedSessionId) {
      args.push("--session", selectedSessionId)
    } else if (sessionSystemPrompt && sessionSystemPrompt.trim() !== "") {
      args.push("--system", sessionSystemPrompt.trim())
    }

    var historySlice = updated.slice(0, -1).map(function(m) {
      return { role: m.role, content: m.content }
    })
    args.push("--history", JSON.stringify(historySlice))

    streamChatProc.command = args
    streamChatProc.running = true

    Qt.callLater(function() {
      if (chatFlick) chatFlick.contentY = Math.max(0, chatFlick.contentHeight - chatFlick.height)
    })
  }

  function handleStreamLine(line) {
    var trimmed = String(line || "").trim()
    if (!trimmed) return
    try {
      var ev = JSON.parse(trimmed)
      if (ev.type === "start") {
        if (ev.session_id) {
          root.streamingSessionId = ev.session_id
          if (!root.selectedSessionId) {
            root.selectedSessionId = ev.session_id
          }
        }
      } else if (ev.type === "delta") {
        root.currentStreamingContent += ev.content
      } else if (ev.type === "tool_progress") {
        var tools = root.currentToolEvents.slice()
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
        root.currentToolEvents = tools
      } else if (ev.type === "done") {
        root.isStreaming = false
        var targetSessionId = ev.session_id || root.streamingSessionId || root.selectedSessionId
        var replyText = ev.full_text || root.currentStreamingContent

        if (root.selectedSessionId === targetSessionId) {
          var finalMsgs = root.messages.slice()
          finalMsgs.push({
            role: "assistant",
            content: replyText,
            timestamp: new Date().toISOString(),
            tool_events: root.currentToolEvents.slice()
          })
          root.messages = finalMsgs
        }

        root.currentStreamingContent = ""
        root.currentToolEvents = []
        root.streamingSessionId = ""
        root.refreshSessions()

        var isCurrentlyViewing = root.opened && (root.selectedSessionId === targetSessionId)
        if (!isCurrentlyViewing) {
          root.postCompletionNotification(replyText, false, targetSessionId)
        }
      } else if (ev.type === "error") {
        root.isStreaming = false
        var targetSessionId = ev.session_id || root.streamingSessionId || root.selectedSessionId
        root.statusError = ev.error

        if (root.selectedSessionId === targetSessionId) {
          var errMsgs = root.messages.slice()
          errMsgs.push({
            role: "assistant",
            content: "⚠️ Error: " + ev.error,
            timestamp: new Date().toISOString()
          })
          root.messages = errMsgs
        }

        root.currentStreamingContent = ""
        root.currentToolEvents = []
        root.streamingSessionId = ""

        var isCurrentlyViewing = root.opened && (root.selectedSessionId === targetSessionId)
        if (!isCurrentlyViewing) {
          root.postCompletionNotification(ev.error, true, targetSessionId)
        }
      }
    } catch (e) {
      // Partial chunk
    }
    if (chatFlick) {
      chatFlick.contentY = Math.max(0, chatFlick.contentHeight - chatFlick.height)
    }
  }

  function cancelStreaming() {
    if (streamChatProc.running) {
      streamChatProc.running = false
    }
    var wasTargetSession = (selectedSessionId === streamingSessionId || !streamingSessionId)
    isStreaming = false
    streamingSessionId = ""
    if (currentStreamingContent) {
      if (wasTargetSession) {
        var updated = messages.slice()
        updated.push({
          role: "assistant",
          content: currentStreamingContent,
          timestamp: new Date().toISOString(),
          tool_events: currentToolEvents.slice()
        })
        messages = updated
      }
      currentStreamingContent = ""
      currentToolEvents = []
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
      targetTitle = (root.selectedSessionId === targetId ? root.activeSessionTitle : "") || "Hermes Agent"
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
      '  omarchy-notification-send --app-name "Hermes Agent" -u "$1" -g "$2" "$3" "$4" --exec "${@:5}"; ' +
      'else ' +
      '  notify-send -a "Hermes Agent" -u "$1" "$3" "$4"; ' +
      'fi',
      "bash",
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
    function testNotify(): string {
      root.postCompletionNotification("Test response from Hermes Agent", false, root.selectedSessionId)
      return "ok"
    }
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
    id: streamChatProc
    running: false
    command: []
    stdout: SplitParser {
      onRead: function(line) {
        root.handleStreamLine(line)
      }
    }
    stderr: StdioCollector {
      id: streamStderr
      waitForEnd: true
      onStreamFinished: function(text) {
        if (text && text.trim()) console.warn("hermes-bridge/stream-chat stderr:", text)
      }
    }
    onExited: function(exitCode) {
      if (root.isStreaming) {
        var targetSessionId = root.streamingSessionId || root.selectedSessionId
        if (exitCode !== 0 && !root.currentStreamingContent) {
          var errText = String(streamStderr.text || "").trim() || "Bridge process error (code " + exitCode + ")"
          if (root.selectedSessionId === targetSessionId) {
            var msgs = root.messages.slice()
            msgs.push({
              role: "assistant",
              content: "⚠️ " + errText,
              timestamp: new Date().toISOString()
            })
            root.messages = msgs
          }
          var isCurrentlyViewing = root.opened && (root.selectedSessionId === targetSessionId)
          if (!isCurrentlyViewing) {
            root.postCompletionNotification(errText, true, targetSessionId)
          }
        }
        root.cancelStreaming()
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
    tooltipText: root.isConnected ? "Hermes Agent (Live)" : "Hermes Agent (Offline)"

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
      onCloseRequested: root.close()

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
              text: "Hermes Agent"
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
                onClicked: root.startNewSession()
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
          }
        }

        PanelSeparator {
          Layout.fillWidth: true
          foreground: root.foreground
        }

        // ------------------------- Dual-Pane Body
        RowLayout {
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

                delegate: Rectangle {
                  id: sessionDelegate
                  property bool confirmingDelete: false
                  width: sessionListView.width
                  height: 50
                  radius: 6
                  color: root.selectedSessionId === modelData.id
                    ? root.cardHover
                    : (delegateMouse.containsMouse ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.05) : "transparent")
                  border.color: sessionDelegate.confirmingDelete
                    ? "#EF4444"
                    : (root.selectedSessionId === modelData.id ? root.accent : "transparent")

                  // Auto-cancel confirmation timer if left unclicked for 4 seconds
                  Timer {
                    id: confirmTimer
                    interval: 4000
                    running: sessionDelegate.confirmingDelete
                    onTriggered: sessionDelegate.confirmingDelete = false
                  }

                  MouseArea {
                    id: delegateMouse
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: {
                      if (sessionDelegate.confirmingDelete) {
                        sessionDelegate.confirmingDelete = false
                      } else {
                        root.selectSession(modelData.id)
                      }
                    }
                  }

                  RowLayout {
                    anchors.fill: parent
                    anchors.margins: 8
                    spacing: 6

                    ColumnLayout {
                      Layout.fillWidth: true
                      spacing: 2

                      RowLayout {
                        Layout.fillWidth: true
                        spacing: 4

                        Text {
                          text: sessionDelegate.confirmingDelete ? "Delete this session?" : (modelData.title || "Untitled Session")
                          font.family: root.fontFamily
                          font.pixelSize: 11
                          font.weight: sessionDelegate.confirmingDelete ? Font.DemiBold : Font.Medium
                          color: sessionDelegate.confirmingDelete ? "#EF4444" : root.foreground
                          elide: Text.ElideRight
                          Layout.fillWidth: true
                        }

                        Text {
                          text: "●"
                          font.family: root.fontFamily
                          font.pixelSize: 8
                          color: "#10B981"
                          visible: !sessionDelegate.confirmingDelete && root.isStreaming && root.streamingSessionId === modelData.id
                        }
                      }

                      RowLayout {
                        spacing: 4
                        visible: !sessionDelegate.confirmingDelete
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

                    // Normal state: Trash icon button
                    Rectangle {
                      visible: !sessionDelegate.confirmingDelete && (delegateMouse.containsMouse || root.selectedSessionId === modelData.id)
                      width: 22
                      height: 22
                      radius: 4
                      color: delMouse.containsMouse ? Qt.rgba(239/255, 68/255, 68/255, 0.2) : "transparent"

                      MouseArea {
                        id: delMouse
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: sessionDelegate.confirmingDelete = true
                      }

                      Text {
                        anchors.centerIn: parent
                        text: "\uF1F8" // Trash icon
                        font.family: root.fontFamily
                        font.pixelSize: 10
                        color: delMouse.containsMouse ? "#EF4444" : root.dimText
                      }
                    }

                    // Confirm state: Checkmark (Confirm) and Cross (Cancel) buttons
                    RowLayout {
                      visible: sessionDelegate.confirmingDelete
                      spacing: 4

                      // Confirm delete button
                      Rectangle {
                        width: 22
                        height: 22
                        radius: 4
                        color: confirmDelMouse.containsMouse ? "#EF4444" : Qt.rgba(239/255, 68/255, 68/255, 0.2)

                        MouseArea {
                          id: confirmDelMouse
                          anchors.fill: parent
                          hoverEnabled: true
                          cursorShape: Qt.PointingHandCursor
                          onClicked: {
                            sessionDelegate.confirmingDelete = false
                            root.deleteSession(modelData.id)
                          }
                        }

                        Text {
                          anchors.centerIn: parent
                          text: "\uF00C" // Checkmark
                          font.family: root.fontFamily
                          font.pixelSize: 10
                          color: confirmDelMouse.containsMouse ? "#FFFFFF" : "#EF4444"
                        }
                      }

                      // Cancel delete button
                      Rectangle {
                        width: 22
                        height: 22
                        radius: 4
                        color: cancelDelMouse.containsMouse ? root.cardHover : "transparent"

                        MouseArea {
                          id: cancelDelMouse
                          anchors.fill: parent
                          hoverEnabled: true
                          cursorShape: Qt.PointingHandCursor
                          onClicked: sessionDelegate.confirmingDelete = false
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
                  visible: !root.isEditingTitle
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

              ColumnLayout {
                id: chatColumn
                width: chatFlick.width
                spacing: 12

                // Empty state greeting
                Item {
                  Layout.fillWidth: true
                  implicitHeight: emptyCol.implicitHeight + 40
                  visible: root.messages.length === 0 && !root.isStreaming

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
                      text: "How can Hermes help you today?"
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
                  visible: root.isStreaming && (root.selectedSessionId === root.streamingSessionId || !root.streamingSessionId)

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
                            running: root.isStreaming && (root.selectedSessionId === root.streamingSessionId || !root.streamingSessionId) && !root.currentStreamingContent
                            loops: Animation.Infinite
                            NumberAnimation { from: 0.2; to: 1.0; duration: 400 }
                            NumberAnimation { from: 1.0; to: 0.2; duration: 400 }
                          }
                        }

                        Text {
                          text: "Hermes is thinking..."
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
                        root.close()
                        event.accepted = true
                      }
                    }

                    Text {
                      anchors.verticalCenter: parent.verticalCenter
                      anchors.left: parent.left
                      text: "Ask Hermes a question or assign a task..."
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
                  color: root.isStreaming
                    ? Qt.rgba(239/255, 68/255, 68/255, 0.2)
                    : (sendHover.containsMouse ? root.accent : Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.8))

                  MouseArea {
                    id: sendHover
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: {
                      if (root.isStreaming) {
                        root.cancelStreaming()
                      } else {
                        root.sendCurrentMessage()
                      }
                    }
                  }

                  Text {
                    anchors.centerIn: parent
                    text: root.isStreaming ? "\uF04D" : "\uF1D8" // Stop vs Send Paper Airplane
                    font.family: root.fontFamily
                    font.pixelSize: 12
                    color: root.isStreaming ? "#EF4444" : "#FFFFFF"
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
