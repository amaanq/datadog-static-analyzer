using System.Xml;

class MyClass {
    public static void doQuery(Int32 userId)
    {
        using (SqlConnection connection = new SqlConnection(connectionString))
        {
            SqlCommand command = new SqlCommand("SELECT attr FROM table WHERE id=" + userID, connection);
        }
    }
}
