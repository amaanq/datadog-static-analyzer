public class MyController : Controller
{
    [ValidateInput(false)]
    public IActionResult MyRequest()
    {
        Console.WriteLine("inside controller");
    }
}