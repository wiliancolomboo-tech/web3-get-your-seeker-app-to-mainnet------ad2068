curl -X POST http://localhost:3000/api/v1/pix-webhook \
     -H "Content-Type: application/json" \
     -d '{
       "pix": [{
         "endToEndId": "E0003816620240901183050987123456",
         "txid": "ORD-1725200000000",
         "valor": "50.00",
         "horario": "2024-09-01T18:30:50Z",
         "pagador": {
           "nome": "Guilherme Santos"
         }
       }]
     }'