import QtQuick
import qs.Ui

// Bar entry point. Reuses the Omarchy glyph so the bar keeps its familiar
// launcher button; the click toggles Spotlight instead of the stock menu.
BarWidget {
  id: root
  moduleName: "k0d3d.spotlight"

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "\uf002"
    fontFamily: "JetBrainsMono Nerd Font"

    onPressed: function(button) {
      if (!root.bar) return
      if (button === Qt.RightButton) root.bar.run("xdg-terminal-exec")
      else root.bar.run("omarchy-shell shell toggle k0d3d.spotlight '{\"menu\":\"root\"}'")
    }
  }
}
