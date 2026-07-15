# Prompt sugerido para o Lovable

Cole algo próximo disso no Lovable:

```text
Use este repositório como base do front do ZAPMRO.

Importante:
- Não migre o backend atual para Supabase Edge Functions.
- O backend permanece em Node.js + Express + Socket.IO fora do Lovable.
- O front precisa continuar compatível com a configuração de backend externo definida em Public/config.js.
- Preserve as integrações existentes com /api e Socket.IO.

Objetivo:
- Modernizar o visual do painel e do CRM.
- Melhorar responsividade, hierarquia visual e experiência de uso.
- Manter o fluxo atual de autenticação, sessões, QR Code, CRM, Kanban, agenda e contatos.
- Se possível, organizar o front gradualmente em componentes mais fáceis de manter.

Regras:
- Não quebrar chamadas já existentes do backend.
- Não remover funcionalidades atuais.
- Se precisar refatorar, faça por etapas pequenas e seguras.
```

## Configuração importante

Se o front estiver rodando fora do backend, configure:

```js
localStorage.setItem('zapmro_api_base_url', 'https://SEU-BACKEND.com');
localStorage.setItem('zapmro_socket_url', 'https://SEU-BACKEND.com');
location.reload();
```
