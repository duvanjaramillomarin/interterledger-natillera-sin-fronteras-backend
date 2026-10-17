import { createAuthenticatedClient } from '@interledger/open-payments'
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { QueryCommand, DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

export const handler = async (event: any) => {
  try {
    const userInfo = await getUserInfo(event.auth.username);
    const keys = userInfo.walletInfo.walletKeys;
    const client = await createAuthenticatedClient({
      walletAddressUrl: keys.walletAddressUrl,
      privateKey: `-----BEGIN PRIVATE KEY-----\n${keys.privateKey}\n-----END PRIVATE KEY-----\n`,
      keyId: keys.keyId,
      validateResponses: false
    });

    const receivingWalletAddressURL = event.body.walletAddress;
    console.log(receivingWalletAddressURL);

    const receivingWalletAddress = await client.walletAddress.get({
      url: receivingWalletAddressURL
    });

    const incomingPaymentGrant = await client.grant.request(
      {
        url: receivingWalletAddress.authServer,
      },
      {
        access_token: {
          access: [
            {
              type: "incoming-payment",
              actions: ["read", "complete", "create"],
            },
          ],
        },
      }
    );

    const incomingPayment = await client.incomingPayment.create(
      {
        url: receivingWalletAddress.resourceServer,
        accessToken: incomingPaymentGrant.access_token.value,
      },
      {
        walletAddress: receivingWalletAddress.id,
        incomingAmount: {
          assetCode: receivingWalletAddress.assetCode,
          assetScale: receivingWalletAddress.assetScale,
          value: event.body.amount,
        },
      }
    );

    const quoteGrant = await client.grant.request(
      {
        url: userInfo.walletInfo.authServer,
      },
      {
        access_token: {
          access: [
            {
              type: "quote",
              actions: ["create", "read"],
            },
          ],
        },
      }
    );

    const quote = await client.quote.create(
      {
        url: userInfo.walletInfo.resourceServer,
        accessToken: quoteGrant.access_token.value,
      },
      {
        walletAddress: userInfo.walletInfo.id,
        receiver: incomingPayment.id,
        method: "ilp",
      }
    );

    //TO DO
    //should save an event in table dynamodb payments-history con el status de quoted pending

    return quote;

    //TO DO
    //next step or next lambda 
    const outgoingPaymentGrant = await client.grant.request(
      {
        url: userInfo.walletInfo.authServer,
      },
      {
        access_token: {
          access: [
            {
              type: "outgoing-payment",
              actions: ["read", "create"],
              limits: {
                debitAmount: {
                  assetCode: quote.debitAmount.assetCode,
                  assetScale: quote.debitAmount.assetScale,
                  value: quote.debitAmount.value,
                },
              },
              identifier: userInfo.walletInfo.id,
            },
          ],
        },
        interact: {
          start: ["redirect"],
        },
      }
    );

    console.log(outgoingPaymentGrant.interact.redirect);

  } catch (error) {
    console.log(error);
    throw error;
  }
}

const getUserInfo = async (username: string) => {
  try {
    const client = new DynamoDBClient({ region: 'us-east-2' });
    const docClient = DynamoDBDocumentClient.from(client);

    const command = new QueryCommand({
      TableName: process.env.USER_VIEW_TABLE,
      KeyConditionExpression: "#source = :source",
      Limit: 1,
      ScanIndexForward: false,
      ExpressionAttributeValues: {
        ":source": username,
      },
      ExpressionAttributeNames: {
        '#source': 'source'
      }
    });

    const response = await docClient.send(command);
    return response.Items[0] || null;
  } catch (error) {
    throw error;
  }
}

const savePaymentHistory = async (params: any) => {
  try {
    const client = new DynamoDBClient({ region: 'us-east-2' });
    const docClient = DynamoDBDocumentClient.from(client);

    try {
      const data = await docClient.send(new PutCommand(params));
      console.log("¡Evento guardado con éxito!", data);
    } catch (error) {
      console.error("Error al guardar el evento:", error);
    }
  } catch (error) {
    throw error;
  }
}
