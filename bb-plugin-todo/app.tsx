import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { TodoCard } from "./composer-card.js";
import { TodoEditor } from "./editor.js";
import { TODO_PANEL_ACTION_ID } from "./panel-action.js";
import "./app.css";

export default definePluginApp(app => {
  app.slots.threadPanelAction({ id: TODO_PANEL_ACTION_ID, title: "Todos", icon: "ListTodo", layout: "flush", component: TodoEditor });
  app.composer.customize({ id: "bb-todo", scopes: ["thread", "queued-message"], banners: [{ id: "todos", chrome: "bare", component: TodoCard }] });
});
