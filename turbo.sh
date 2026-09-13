#!/bin/bash
curl -s --max-time 8 http://127.0.0.1:11435/api/tags | node -e "let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>{try{console.log(\"turbo tunnel up:\",JSON.parse(d).models.map(m=>m.name).join(\", \"))}catch{console.log(\"turbo tunnel DOWN\")}})"; cat /root/nerxux/server/.compute-state.json; echo
