import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { TodoCard } from "./composer-card.js";
import "./app.css";

export default definePluginApp(app => {
  app.composer.customize({ id: "bb-todo", scopes: ["thread", "queued-message"], banners: [{ id: "todos", chrome: "bare", component: TodoCard }] });
});
