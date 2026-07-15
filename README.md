# ZAPMRO Front + Backend

Este repositório foi preparado para:

- versionar o projeto com segurança no GitHub;
- conectar o código ao Lovable para continuar evoluindo o front;
- manter o backend Node.js fora do Lovable/Supabase Edge Functions.

## Estrutura atual

- `Public/`: front atual em HTML/JS estático.
- `Server/`: backend Express + Socket.IO + `whatsapp-web.js`.
- `data/`: dados locais e de runtime. Fica fora do Git.

## Importante sobre Lovable e Edge Functions

O front pode ser mantido e evoluído no Lovable.

O backend atual **não deve** ser migrado para Supabase Edge Functions porque depende de:

- processo Node persistente;
- Socket.IO em tempo real;
- `whatsapp-web.js` e automação com navegador;
- arquivos locais e sessões em disco.

O caminho recomendado é:

1. manter o backend em um host Node separado;
2. usar o Lovable para editar e melhorar o front;
3. apontar o front para a URL pública do backend.

## Configuração do front para backend externo

O front usa `Public/config.js` e aceita estas chaves no navegador:

- `localStorage["zapmro_api_base_url"]`
- `localStorage["zapmro_socket_url"]`

Exemplo no console do navegador:

```js
localStorage.setItem('zapmro_api_base_url', 'https://api.seudominio.com');
localStorage.setItem('zapmro_socket_url', 'https://api.seudominio.com');
location.reload();
```

Se nada for configurado, o front usa `window.location.origin`.

## Variáveis de ambiente

Copie `.env.example` para `.env` no ambiente do backend e preencha os valores reais.

## Execução local do backend

```bash
npm install
npm start
```
